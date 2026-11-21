import * as adapter from './apiko.json';
import type { LoginTokenService } from '../../connectors/engines/login-token.service';
import type { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { RestEngine } from '../../connectors/engines/rest.engine';

describe('APIKO adapter contract', () => {
  it('uses the model list for read-only credential validation', () => {
    expect(adapter.connector).toMatchObject({
      baseUrl: 'https://api.apiko.app',
      authType: 'BEARER_TOKEN',
      authConfig: { token: '{{APIKO_API_KEY}}' },
      healthcheckPath: '/v1/models',
    });
    expect(adapter.probe.tool).toBe('apiko_list_models');
    expect(adapter.tools.find((tool) => tool.name === adapter.probe.tool)?.endpointMapping).toMatchObject({
      method: 'GET',
      path: '/v1/models',
    });
  });

  it('leaves the billable action disabled and uses the same public task API to poll', () => {
    expect(adapter.tools.find((tool) => tool.name === 'apiko_create_wan_video')).toMatchObject({
      enabled: false,
      endpointMapping: {
        method: 'POST',
        path: '/v1/videos',
        bodyMapping: { model: 'wan3.0-text-to-video', prompt: '$prompt' },
      },
    });
    expect(adapter.tools.find((tool) => tool.name === 'apiko_get_video')?.endpointMapping).toMatchObject({
      method: 'GET',
      path: '/v1/videos/{task_id}',
    });
  });
});

const describeLive = process.env.RUN_APIKO_LIVE === '1' ? describe : describe.skip;

async function callTool(
  name: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const key = process.env.APIKO_API_KEY;
  if (!key) throw new Error('Set APIKO_API_KEY for the live test.');
  const tool = adapter.tools.find((item) => item.name === name);
  if (!tool) throw new Error(`Tool ${name} is missing.`);

  const engine = new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
  try {
    return await engine.execute(
      {
        ...adapter.connector,
        authConfig: { token: key },
        logSecrets: [key],
      },
      tool.endpointMapping,
      params,
    );
  } catch (error) {
    const failure = error as { response?: { status?: number }; code?: string };
    throw new Error(`${name} failed (${failure.response?.status ?? failure.code ?? 'unknown error'}).`);
  }
}

describeLive('APIKO connector live', () => {
  it('accepts a test key with Wan 3.0 access', async () => {
    const payload = (await callTool(adapter.probe.tool)) as { data: Array<{ id: string }> };
    expect(payload.data.some((model) => model.id === 'wan3.0-text-to-video')).toBe(true);
  }, 40_000);

  // Billing requires a separate opt-in even when model discovery is enabled.
  const itPaid = process.env.RUN_APIKO_VIDEO_LIVE === '1' ? it : it.skip;
  itPaid('creates a Wan 3.0 job, polls it and downloads an MP4', async () => {
    type VideoTask = { id: string; status: string; video_url?: string };

    const created = (await callTool('apiko_create_wan_video', {
      prompt: 'A paper boat drifting on a lake at sunrise, wide static shot.',
      duration: 2,
      resolution: '480p',
      aspect_ratio: '16:9',
    })) as VideoTask;
    expect(created.id).toMatch(/^task_/);

    const deadline = Date.now() + 360_000;
    let task = created;
    while (!['completed', 'failed'].includes(task.status) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      task = (await callTool('apiko_get_video', { task_id: created.id })) as VideoTask;
      expect(task.id).toBe(created.id);
    }
    if (task.status !== 'completed' || !task.video_url) {
      throw new Error(`Task ${created.id} ended the wait with status ${task.status}.`);
    }

    const response = await fetch(task.video_url, { signal: AbortSignal.timeout(30_000) });
    expect(response.status).toBe(200);
    const video = Buffer.from(await response.arrayBuffer());
    expect(video.subarray(4, 8).toString('ascii')).toBe('ftyp');
    console.info(`APIKO task ${created.id} completed, MP4 received (${video.length} bytes).`);
  }, 450_000);
});
