import { PrismaService } from '../../common/prisma.service';
import { KgSkillService } from '../../knowledge-graph/kg-skill.service';
import { KgService } from '../../knowledge-graph/kg.service';
import { KnowledgeFoldersService } from '../../knowledge-folders/knowledge-folders.service';
import { LearningService } from './learning.service';

/**
 * Learning projects against a real database. The unit tests use a stand-in
 * for the tables; this one proves that the filters the services write are
 * valid for Prisma and Postgres, above all the audience rule, which runs on
 * every MCP request that serves skills. A lesson is followed from the member's
 * AI client to the skill everyone is served.
 */
const prisma = new PrismaService();

const TAG = `learning-db-${Date.now()}`;
const ORG = `${TAG}-org`;
const OTHER_ORG = `${TAG}-other-org`;
const ADMIN = `${TAG}-admin`;
const EXPERT = `${TAG}-expert`;
const COLLEAGUE = `${TAG}-colleague`;
const READER = `${TAG}-reader`;
const SERVER = `${TAG}-server`;

const access: any = {
  allowance: async () => ({ max: null, full: true, plan: 'enterprise' }),
  usage: async () => ({ max: null, full: true, plan: 'enterprise', used: 0 }),
  assertCanOpen: async () => undefined,
};
const securityEvents: any = { log: jest.fn() };
const skills = new KgSkillService(prisma, {} as any);
const folders = new KnowledgeFoldersService(prisma, { hasEnterprise: async () => true } as any, securityEvents);
const learning = new LearningService(prisma, access, skills, securityEvents);

/** What a caller is served on the project's server, through the paths the MCP endpoint uses. */
async function served(userId: string | null) {
  const who = await folders.accessFor(ORG, userId);
  const [text, visible, hints, list] = await Promise.all([
    skills.activeSkillsText(ORG, SERVER, [], 'inline', who),
    skills.hasVisible(ORG, SERVER, [], who),
    skills.toolHints(ORG, SERVER, [], who),
    skills.listForCaller(ORG, SERVER, [], undefined, who),
  ]);
  const first = list[0] ? await skills.getForCaller(ORG, SERVER, [], list[0].id, who) : null;
  return { text: text ?? '', visible, hints: hints.length, ids: list.map((s) => s.id), body: first?.body ?? null };
}

beforeAll(async () => {
  await prisma.$connect();
  for (const id of [ORG, OTHER_ORG]) await prisma.organization.create({ data: { id, name: id } });
  for (const [id, role] of [
    [ADMIN, 'ADMIN'],
    [EXPERT, 'EDITOR'],
    [COLLEAGUE, 'EDITOR'],
    [READER, 'VIEWER'],
  ] as const) {
    await prisma.user.create({ data: { id, email: `${id}@test.local`, role, organizationId: ORG } });
    await prisma.organizationMember.create({ data: { userId: id, organizationId: ORG, role } });
  }
  await prisma.mcpServerConfig.create({ data: { id: SERVER, userId: ADMIN, organizationId: ORG, name: 'Sales', slug: TAG } });
});

afterAll(async () => {
  // Organizations cascade to everything created here; users go last.
  await prisma.organization.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
  await prisma.user.deleteMany({ where: { id: { in: [ADMIN, EXPERT, COLLEAGUE, READER] } } });
  await prisma.$disconnect();
});

describe('learning projects on a real database', () => {
  let active: { projectId: string; organizationId: string };
  let topicId: string;
  let lessonId: string;

  it('serves nothing before a lesson exists, with the audience rule in every query', async () => {
    for (const who of [EXPERT, COLLEAGUE, null]) {
      expect(await served(who)).toEqual({ text: '', visible: false, hints: 0, ids: [], body: null });
    }
  });

  it('starts when its member accepts, and is active for that member on that server only', async () => {
    const project = await learning.create(
      ORG,
      { name: 'Old window hardware', userId: EXPERT, mcpServerId: SERVER, tags: ['windows'] },
      { actorUserId: ADMIN },
    );
    expect(await learning.activeFor(ORG, EXPERT, SERVER)).toBeNull();
    await learning.consent(ORG, project.id, EXPERT, 'Your lessons on this server are kept as skills.', {
      actorUserId: EXPERT,
    });
    const found = await learning.activeFor(ORG, EXPERT, SERVER);
    expect(found).toEqual(expect.objectContaining({ projectId: project.id, name: 'Old window hardware', topics: [] }));
    expect(await learning.activeFor(ORG, COLLEAGUE, SERVER)).toBeNull();
    expect(await learning.activeFor(OTHER_ORG, EXPERT, SERVER)).toBeNull();
    active = { projectId: project.id, organizationId: ORG };
  });

  it('keeps a lesson in a draft only the member is served', async () => {
    const saved = await learning.record(active, {
      topic: 'Old windows',
      kind: 'correction',
      text: 'Take hinge BR-12103 for series 300',
      before: 'hinge BR-99',
      after: 'hinge BR-12103',
      reason: 'BR-99 is discontinued',
      whenToUse: 'Quotes for old windows',
    });
    topicId = saved.topicId;
    lessonId = saved.id;

    const expert = await served(EXPERT);
    expect(expert.visible).toBe(true);
    expect(expert.ids).toHaveLength(1);
    expect(expert.text).toContain('Old windows');
    expect(expert.body).toContain('Instead of: hinge BR-99. Use: hinge BR-12103.');

    // A colleague, and a caller without a user (an API key), get nothing.
    for (const who of [COLLEAGUE, null]) {
      expect(await served(who)).toEqual({ text: '', visible: false, hints: 0, ids: [], body: null });
    }
    // The same lesson again is counted, not stored twice.
    const again = await learning.record(active, { topic: 'old windows', kind: 'correction', text: 'take hinge BR-12103 for series 300!' });
    expect(again).toEqual(expect.objectContaining({ id: lessonId, repeated: true }));
  });

  it('keeps the draft out of the knowledge graph answer for others', async () => {
    const kg = new KgService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any);
    const scoped = (userId: string | null) =>
      folders.accessFor(ORG, userId).then((who) => (kg as any).scopedSkills(ORG, { mcpServerId: SERVER, folders: who }));
    expect(await scoped(EXPERT)).toHaveLength(1);
    expect(await scoped(COLLEAGUE)).toEqual([]);
  });

  it('publishes the confirmed lesson for everyone, and the member keeps one skill, not two', async () => {
    const review = await learning.review(active);
    expect(review.lessons.map((l) => l.id)).toEqual([lessonId]);
    await learning.confirm(active, [{ id: lessonId, verdict: 'confirm' }], EXPERT);
    await learning.record(active, { topic: 'Old windows', kind: 'rule', text: 'Not confirmed yet: maybe add spare screws' });
    const published = await learning.publish(ORG, topicId, { actorUserId: ADMIN });

    const colleague = await served(COLLEAGUE);
    expect(colleague.ids).toEqual([published.skillId]);
    expect(colleague.body).toContain('hinge BR-12103');
    expect(colleague.body).not.toContain('spare screws');

    // The member is served the draft, which holds everything, instead of the published copy.
    const expert = await served(EXPERT);
    expect(expert.ids).toHaveLength(1);
    expect(expert.ids[0]).not.toBe(published.skillId);
    expect(expert.body).toContain('spare screws');

    const row = await prisma.kgSkillSuggestion.findUnique({ where: { id: published.skillId } });
    expect(row).toEqual(
      expect.objectContaining({ source: 'learning', originUserId: EXPERT, audienceUserId: null, tags: ['windows', 'learned'] }),
    );
  });

  it('lists the project with its counts for the dashboard', async () => {
    const list = await learning.list(ORG, { isAdmin: true });
    expect(list.projects[0]).toEqual(
      expect.objectContaining({
        name: 'Old window hardware',
        status: 'active',
        topics: 1,
        lessons: { draft: 1, confirmed: 1, rejected: 0 },
        expert: expect.objectContaining({ id: EXPERT }),
        mcpServer: { id: SERVER, name: 'Sales' },
      }),
    );
    const detail = await learning.get(ORG, active.projectId, { isAdmin: false });
    expect(detail.expert).toBeNull();
    expect(detail.topics[0]).toEqual(expect.objectContaining({ title: 'Old windows', unpublished: false }));
    expect((await learning.lessons(ORG, active.projectId, { status: 'draft' })).total).toBe(1);
  });

  it('after the member stops and erases, everyone is served the published skill and the rest is gone', async () => {
    const res = await learning.withdraw(ORG, active.projectId, EXPERT, { erase: true }, { actorUserId: EXPERT });
    expect(res.erased).toBe(1);
    expect(await learning.activeFor(ORG, EXPERT, SERVER)).toBeNull();
    const expert = await served(EXPERT);
    const colleague = await served(COLLEAGUE);
    expect(expert.ids).toEqual(colleague.ids);
    expect(expert.body).not.toContain('spare screws');
    expect(await prisma.kgSkillSuggestion.count({ where: { organizationId: ORG, audienceUserId: { not: null } } })).toBe(0);
  });

  it('keeps the published skill when the member\'s account is deleted, without the link to the person', async () => {
    await prisma.organizationMember.deleteMany({ where: { userId: EXPERT } });
    await prisma.user.delete({ where: { id: EXPERT } });
    const [skill] = await prisma.kgSkillSuggestion.findMany({ where: { organizationId: ORG } });
    expect(skill).toEqual(expect.objectContaining({ source: 'learning', originUserId: null }));
    expect((await prisma.learningProject.findFirst({ where: { organizationId: ORG } }))?.userId).toBeNull();
    expect((await served(COLLEAGUE)).ids).toEqual([skill.id]);
  });
});

/**
 * Topics set by an admin, each filed in its own folder, and a folder limited
 * to a role the expert lacks (#1770). Runs after the block above, whose
 * project has ended: the colleague is the expert here.
 */
describe('learning topics in their own folders on a real database', () => {
  const ROLE = `${TAG}-shop-role`;
  let folderId: string;
  let active: { projectId: string; organizationId: string };

  beforeAll(async () => {
    await prisma.role.create({ data: { id: ROLE, name: ROLE, organizationId: ORG } });
    await prisma.userRoleAssignment.create({ data: { userId: READER, roleId: ROLE, organizationId: ORG } });
    folderId = (await prisma.knowledgeFolder.create({ data: { organizationId: ORG, name: 'Shop support', roleIds: [ROLE] } }))
      .id;
  });

  it('creates the project with its topics, and the expert gets their draft back in a folder limited to a role they lack', async () => {
    const project = await learning.create(
      ORG,
      {
        name: 'Shop support',
        userId: COLLEAGUE,
        mcpServerId: SERVER,
        topics: [{ title: 'Shop support', whenToUse: 'Questions about the web shop', folderId }],
      },
      { actorUserId: ADMIN },
    );
    await learning.consent(ORG, project.id, COLLEAGUE, 'Your lessons on this server are kept as skills.', {
      actorUserId: COLLEAGUE,
    });
    active = { projectId: project.id, organizationId: ORG };
    const found = await learning.activeFor(ORG, COLLEAGUE, SERVER);
    expect(found!.topics).toEqual([expect.objectContaining({ title: 'Shop support', whenToUse: 'Questions about the web shop' })]);

    const before = (await served(COLLEAGUE)).ids;
    const saved = await learning.record(active, {
      topic: 'shop support',
      kind: 'rule',
      text: 'Send portal invitations only to the main contact of a customer',
    });
    const draft = await prisma.kgSkillSuggestion.findFirst({ where: { organizationId: ORG, audienceUserId: COLLEAGUE } });
    expect(draft).toEqual(expect.objectContaining({ folderId, title: 'Shop support' }));

    const expert = await served(COLLEAGUE);
    expect(expert.ids).toEqual(expect.arrayContaining([draft!.id, ...before]));
    // Holding the folder's role does not show somebody else's draft.
    expect((await served(READER)).ids).not.toContain(draft!.id);

    // Published: for the folder's role, still not for the expert's colleagues without it.
    await learning.confirm(active, [{ id: saved.id, verdict: 'confirm' }], COLLEAGUE);
    const { skillId } = await learning.publish(ORG, saved.topicId, { actorUserId: ADMIN });
    expect((await served(READER)).ids).toContain(skillId);
    const unrelated = await folders.accessFor(ORG, null);
    expect((await skills.listForCaller(ORG, SERVER, [], undefined, unrelated)).map((x) => x.id)).not.toContain(skillId);
    // The expert keeps their draft instead of the published copy.
    const again = await served(COLLEAGUE);
    expect(again.ids).toContain(draft!.id);
    expect(again.ids).not.toContain(skillId);
  });

  it('moves a topic and its skills to another folder', async () => {
    const [topic] = await prisma.learningTopic.findMany({ where: { organizationId: ORG, projectId: active.projectId } });
    await learning.updateTopic(ORG, topic.id, { folderId: null, title: 'Web shop support' }, { actorUserId: ADMIN });
    const rows = await prisma.kgSkillSuggestion.findMany({ where: { organizationId: ORG, learningProjectId: active.projectId } });
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r).toEqual(expect.objectContaining({ folderId: null, title: 'Web shop support' }));
    // Out of the limited folder: the published skill reaches everyone.
    const anyone = await folders.accessFor(ORG, null);
    expect((await skills.listForCaller(ORG, SERVER, [], undefined, anyone)).length).toBeGreaterThan(0);
  });
});
