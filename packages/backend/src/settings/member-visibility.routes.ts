/**
 * Member visibility: the decision taken for every HTTP route of the API.
 *
 * In a workspace set to `restricted`, a member who is not an admin must see
 * only what their AI client can use: their own calls, the connectors their
 * roles reach and the MCP servers they own. Every route that could answer
 * with workspace data therefore needs an explicit decision, and this table is
 * where it is written down. member-visibility.routes.spec.ts reads every
 * controller through Nest's route metadata and fails when a route is missing
 * here (or listed here but gone), so a new route cannot ship without someone
 * deciding what a restricted member gets from it.
 *
 * Keys are `<ControllerClass>.<handler>`. Decisions:
 *
 * - `scoped`: the route narrows its answer through MemberVisibilityService
 *   (or a service that does, named in the note). Hidden ids answer the 404 of
 *   an unknown id.
 * - `admin-when-restricted`: refused (403) to a member who is not an admin in a
 *   restricted workspace, by MemberVisibilityInterceptor, before the handler
 *   runs. Open workspaces and admins are unchanged. For routes whose answer is
 *   other members' work (the knowledge graph, learning projects) or the whole
 *   workspace's inventory (plan fit), where narrowing makes no sense.
 * - `admin-only`: ADMIN only in every mode (`@Roles('ADMIN')`, or a check in
 *   code named in the note).
 * - `owner-or-admin`: reads or changes one resource the caller owns, or any as
 *   an admin; others get 403/404. Returns nothing of anyone else's resources.
 * - `own-data`: only the caller's own records (profile, keys, grants, links),
 *   or a new resource the caller creates and owns.
 * - `role-governed`: governed by an access model admins assign explicitly
 *   (memory access, knowledge-folder roles, EDITOR curation). Member
 *   visibility does not narrow it further.
 * - `workspace-config`: workspace settings, the public catalog, plan and
 *   licence state or aggregate counts: no other member's records, the same
 *   answer for every member.
 * - `no-member-session`: not reached with a member's dashboard session: public
 *   pages and catalog, signed or token links, provider webhooks and OAuth,
 *   SSO and SCIM flows, cron and internal secrets.
 * - `mcp-roles`: the MCP endpoint; MCP roles decide which tools a client can
 *   list and call, in both modes.
 */
export const MEMBER_VISIBILITY_DECISIONS = [
  'scoped',
  'admin-when-restricted',
  'admin-only',
  'owner-or-admin',
  'own-data',
  'role-governed',
  'workspace-config',
  'no-member-session',
  'mcp-roles',
] as const;
export type MemberVisibilityDecision = (typeof MEMBER_VISIBILITY_DECISIONS)[number];

export interface RouteVisibility {
  decision: MemberVisibilityDecision;
  /** Why, or where the check lives when reflection cannot see it. */
  note?: string;
}

const d = (decision: MemberVisibilityDecision, note?: string): RouteVisibility =>
  note ? { decision, note } : { decision };
const scoped = (note?: string) => d('scoped', note);
const adminWhenRestricted = (note?: string) => d('admin-when-restricted', note);
const admin = (note?: string) => d('admin-only', note);
const ownerOrAdmin = (note?: string) => d('owner-or-admin', note);
const own = (note?: string) => d('own-data', note);
const roleGoverned = (note: string) => d('role-governed', note);
const config = (note?: string) => d('workspace-config', note);
const noSession = (note: string) => d('no-member-session', note);
const mcpRoles = () => d('mcp-roles');

const CONNECTOR_404 = 'hidden connector answers 404; a visible one it does not own comes back in the reduced view';
const OWNER_OR_ADMIN_404 = 'owner or admin; a connector the member cannot see answers 404 first';
const PROVIDER_FLOW = 'provider redirect, authenticated by the signed one-time state';
const FILE_SEARCH_OWNER = '404 unless the member owns the connector (File Search detail is never shared)';

export const MEMBER_VISIBILITY_ROUTES: Readonly<Record<string, RouteVisibility>> = {
  // ── adapters ───────────────────────────────────────────────────────────
  'AdaptersPublicController.list': noSession('public catalog'),
  'AdaptersPublicController.installRanking': noSession('public catalog, aggregate counts'),
  'AdaptersPublicController.instructions': noSession('public catalog'),
  'AdaptersController.popularConnectors': scoped('`installed` only for connectors the member can see'),
  'AdaptersController.matchUrl': config('catalog lookup'),
  'AdaptersController.starterPack': scoped('`installed` only for connectors the member can see; plan usage counts'),
  'AdaptersController.installStarterPack': own('creates connectors owned by the caller'),
  'AdaptersController.getBySlug': config('catalog entry'),
  'AdaptersController.verify': ownerOrAdmin('tries credentials; with connectorId only for its owner or an admin'),
  'AdaptersController.importAdapter': own('creates a connector owned by the caller'),
  'SetupLinksController.resolve': own('the caller\'s own setup link (signed token)'),
  'SetupLinksController.open': noSession('signed setup link'),
  'TelegramManagedBotController.receive': noSession('Telegram webhook, secret token'),
  'TikTokShopInstallController.install': own('installs into a connector owned by the caller'),

  // ── alerts ─────────────────────────────────────────────────────────────
  'AlertsAdminController.getConfig': admin(),
  'AlertsAdminController.saveConfig': admin(),
  'AlertsAdminController.deleteConfig': admin(),
  'AlertsAdminController.testWebhook': admin(),

  // ── audit ──────────────────────────────────────────────────────────────
  'AuditController.listInvocations': scoped('own calls only; servers named only when the member owns them'),
  'AuditController.getStats': scoped('own calls only'),
  'AuditController.getAnalytics': scoped('own calls only'),
  'AuditController.getToolPerformance': scoped('own calls only; servers named only when the member owns them'),
  'AuditController.getBreakdowns': scoped('own calls only; byServer names only own servers, byUser only the caller'),
  'ProductEventController.record': own('records an event for the caller'),
  'SignupAttributionController.clickIds': own(),

  // ── auth ───────────────────────────────────────────────────────────────
  'AuthController.loginWithRecoveryCode': noSession('sign-in'),
  'AuthController.login': noSession('sign-in'),
  'AuthController.register': noSession('sign-up'),
  'AuthController.verifyEmail': own(),
  'AuthController.verifyEmailLink': noSession('signed e-mail link'),
  'AuthController.resendVerification': own(),
  'AuthController.inviteUser': admin(),
  'AuthController.verifyInvite': noSession('invitation token'),
  'AuthController.acceptInvite': noSession('invitation token'),
  'AuthController.forgotPassword': noSession('sign-in'),
  'AuthController.resetPassword': noSession('reset token'),
  'AuthController.recoveryCodeStatus': own(),
  'AuthController.generateRecoveryCodes': own(),
  'LoginController.showLoginPage': noSession('OAuth sign-in and consent page'),
  'LoginController.socialCallback': noSession(PROVIDER_FLOW),
  'LoginController.handleLogin': noSession('OAuth sign-in'),
  'LoginController.handleEmailCode': noSession('OAuth sign-in'),
  'LoginController.resendEmailCode': noSession('OAuth sign-in'),
  'LoginController.continueAfterEmailLink': noSession('OAuth sign-in'),
  'LoginController.socialFromEmailCode': noSession('OAuth sign-in'),
  'LoginController.fileSearchSetupSession': noSession('signed setup session'),
  'LoginController.fileSearchSetupContinue': noSession('signed setup session'),
  'LoginController.handleServerSelection': scoped(
    'consent picker; offers and grants only servers McpConnectionGrantService lets the user see',
  ),
  'LoginController.pickFirstApp': noSession('OAuth consent flow'),
  'LoginController.telegramOneTapQr': noSession('one-time code'),
  'LoginController.telegramOneTapStatus': noSession('one-time code'),
  'LoginController.telegramOneTapToken': noSession('one-time code'),
  'RecentSignInController.who': noSession('signed device cookie'),
  'RecentSignInController.continue': noSession('signed device cookie'),
  'RecentSignInController.forget': noSession('signed device cookie'),
  'SocialAuthController.start': noSession('sign-in'),
  'SocialAuthController.exchange': noSession('sign-in'),
  'SocialAuthController.identities': own(),
  'SocialAuthController.link': own(),
  'SocialAuthController.unlink': own(),
  'UserInfoController.get': own('OIDC userinfo of the token holder'),
  'UserInfoController.post': own('OIDC userinfo of the token holder'),

  // ── connectors ─────────────────────────────────────────────────────────
  'ConnectorsController.list': scoped('owned or holding an allowed tool; reduced view for the ones not owned'),
  'ConnectorsController.create': own('creates a connector owned by the caller'),
  'ConnectorsController.proxyAvailability': config(),
  'ConnectorsController.healthCheck': scoped('visible connectors only; fixed message for the ones not owned'),
  'ConnectorsController.exportAll': scoped('only connectors the member owns'),
  'ConnectorsController.exportOne': scoped('404 unless the member owns the connector'),
  'ConnectorsController.findOne': scoped(`${CONNECTOR_404}; its MCP servers only when the member owns them`),
  'ConnectorsController.webhookUrl': scoped(OWNER_OR_ADMIN_404),
  'ConnectorsController.webhookEventsList': scoped(OWNER_OR_ADMIN_404),
  'ConnectorsController.update': ownerOrAdmin(),
  'ConnectorsController.getOAuthConfig': scoped('404 unless the member owns the connector'),
  'ConnectorsController.updateCredentialScope': ownerOrAdmin(),
  'ConnectorsController.getMyCredential': scoped('the caller\'s own credential; hidden connector answers 404'),
  'ConnectorsController.deleteMyCredential': scoped('the caller\'s own credential; hidden connector answers 404'),
  'ConnectorsController.updateOAuthConfig': ownerOrAdmin(),
  'ConnectorsController.updateOAuth1Config': ownerOrAdmin(),
  'ConnectorsController.remove': ownerOrAdmin(),
  'ConnectorsController.test': scoped(OWNER_OR_ADMIN_404),
  'ConnectorsController.oauthRedirectUri': config(),
  'ConnectorsController.initiateOAuth': scoped('owner or admin, or the caller\'s own per-user sign-in; hidden answers 404'),
  'ConnectorsController.discoverMcpTools': ownerOrAdmin(),
  'ConnectorsController.importAll': own('creates connectors owned by the caller'),
  'ConnectorsController.importFile': own('creates connectors owned by the caller'),
  'ConnectorsController.importSpec': ownerOrAdmin(),
  'ConnectorsController.importTools': ownerOrAdmin(),
  'ConnectorsController.updateEnvVars': ownerOrAdmin(),
  'ConnectorsController.catalogDiff': scoped(OWNER_OR_ADMIN_404),
  'ConnectorsController.resyncCatalog': ownerOrAdmin(),
  'IopAuthController.redirectUri': config(),
  'IopAuthController.authorize': ownerOrAdmin(),
  'IopAuthController.callback': noSession(PROVIDER_FLOW),
  'IopAuthController.complete': own('completes the caller\'s own pending flow'),
  'McpOAuthCallbackController.acknowledgeNotification': noSession('provider notification'),
  'McpOAuthCallbackController.oauthCallback': noSession(PROVIDER_FLOW),
  'McpOAuthCallbackController.complete': own('completes the caller\'s own pending flow'),
  'McpOAuthCallbackController.connectPageComplete': noSession(PROVIDER_FLOW),
  'McpOAuthCallbackController.connectPage': noSession('per-user sign-in page of a connector link, its own session'),
  'McpOAuthCallbackController.connectPageSignIn': noSession('per-user sign-in page of a connector link'),
  'McpOAuthCallbackController.connectPageConnect': noSession('per-user sign-in page of a connector link'),
  'McpOAuthCallbackController.connectPageSwitch': noSession('per-user sign-in page of a connector link'),
  'MetaAuthController.platform': config(),
  'MetaAuthController.authorize': ownerOrAdmin(),
  'MetaAuthController.callback': noSession(PROVIDER_FLOW),
  'MetaAuthController.complete': own('completes the caller\'s own pending flow'),
  'MetaAuthController.listAccounts': ownerOrAdmin(),
  'MetaAuthController.chooseAccount': ownerOrAdmin(),
  'SheinAuthController.redirectUri': config(),
  'SheinAuthController.authorize': ownerOrAdmin(),
  'SheinAuthController.callback': noSession(PROVIDER_FLOW),
  'SheinAuthController.complete': own('completes the caller\'s own pending flow'),
  'ShopeeAuthController.authorize': ownerOrAdmin(),
  'ShopeeAuthController.callback': noSession(PROVIDER_FLOW),
  'ShopeeAuthController.complete': own('completes the caller\'s own pending flow'),
  'TikTokShopAuthController.platform': config(),
  'TikTokShopAuthController.authorize': ownerOrAdmin(),
  'TikTokShopAuthController.callback': noSession(PROVIDER_FLOW),
  'TikTokShopAuthController.complete': own('completes the caller\'s own pending flow'),
  'ToolsController.list': scoped('allowed tools only on a connector the member does not own; hidden answers 404'),
  'ToolsController.create': ownerOrAdmin(),
  'ToolsController.bulkCreate': ownerOrAdmin(),
  'ToolsController.update': ownerOrAdmin(),
  'ToolsController.getAnnotations': scoped(OWNER_OR_ADMIN_404),
  'ToolsController.setAnnotations': ownerOrAdmin(),
  'ToolsController.getResponseMapping': scoped(OWNER_OR_ADMIN_404),
  'ToolsController.setResponseMapping': ownerOrAdmin(),
  'ToolsController.previewMapping': ownerOrAdmin(),
  'ToolsController.setProxy': ownerOrAdmin(),
  'ToolsController.testTool': ownerOrAdmin(),
  'ToolsController.remove': ownerOrAdmin(),
  'WebhookIngestController.receive': noSession('provider webhook, signature checked'),
  'WooCommerceAuthController.oneClick': own('starts the caller\'s own install flow'),
  'WooCommerceAuthController.authorize': ownerOrAdmin(),
  'WooCommerceAuthController.callback': noSession(PROVIDER_FLOW),
  'WooCommerceAuthController.oneClickStatus': own('status of the caller\'s own pending flow'),

  // ── ee/ (Commercial License; decided here, enforced without changing ee/) ──
  'KgCronController.run': noSession('cron secret'),
  'OnboardingCronController.run': noSession('cron secret'),
  'LearningController.allowance': config('plan allowance and counts'),
  'LearningController.mine': own('the caller\'s own learning projects'),
  'LearningController.consent': own('the caller\'s own learning project'),
  'LearningController.withdraw': own('the caller\'s own learning project'),
  'LearningController.list': adminWhenRestricted('other members\' learning projects'),
  'LearningController.create': admin(),
  'LearningController.get': adminWhenRestricted('another member\'s learning project'),
  'LearningController.update': admin(),
  'LearningController.pause': admin(),
  'LearningController.resume': admin(),
  'LearningController.end': admin(),
  'LearningController.remove': admin(),
  'LearningController.lessons': adminWhenRestricted('lessons drawn from another member\'s requests'),
  'LearningController.setLesson': adminWhenRestricted('lessons drawn from another member\'s requests'),
  'LearningController.addTopic': admin(),
  'LearningController.updateTopic': admin(),
  'LearningController.preview': adminWhenRestricted('skill text drawn from another member\'s lessons'),
  'LearningController.publish': adminWhenRestricted('publishes another member\'s lessons'),
  'EditionController.getEdition': config('edition and user limit'),
  'EditionController.startTrial': admin(),
  'SupportController.widget': own('support identity of the caller'),
  'SupportController.webhook': noSession('support desk webhook, secret'),
  'SupportController.deskConnector': noSession('support desk, secret'),

  // ── File Search and File Share ─────────────────────────────────────────
  'FileSearchController.capabilities': config('plan, limits, worker health and aggregate usage'),
  'FileSearchController.test': admin('FileSearchService.assertAdmin'),
  'FileSearchController.createDraft': admin('FileSearchService.assertAdmin'),
  'FileSearchController.getPolicy': config(),
  'FileSearchController.setPolicy': admin('FileSearchService.assertAdmin'),
  'FileSearchController.overview': scoped(FILE_SEARCH_OWNER),
  'FileSearchController.updateSource': scoped(FILE_SEARCH_OWNER),
  'FileSearchController.startScan': scoped(FILE_SEARCH_OWNER),
  'FileSearchController.getScan': scoped(FILE_SEARCH_OWNER),
  'FileSearchController.cancelScan': scoped(FILE_SEARCH_OWNER),
  'FileSearchController.redescribe': scoped(FILE_SEARCH_OWNER),
  'FileSearchController.setSelection': scoped(FILE_SEARCH_OWNER),
  'FileSearchController.activate': scoped(FILE_SEARCH_OWNER),
  'FileSearchController.tree': scoped(FILE_SEARCH_OWNER),
  'FileSearchController.problems': scoped(FILE_SEARCH_OWNER),
  'FileSearchController.runs': scoped(FILE_SEARCH_OWNER),
  'FileSearchController.syncNow': scoped(FILE_SEARCH_OWNER),
  'FileSearchController.pause': scoped(FILE_SEARCH_OWNER),
  'FileSearchController.resume': scoped(FILE_SEARCH_OWNER),
  'FileSearchController.schedule': scoped(FILE_SEARCH_OWNER),
  'FileSearchController.description': scoped(FILE_SEARCH_OWNER),
  'FileSearchController.getRules': scoped(FILE_SEARCH_OWNER),
  'FileSearchController.setRules': scoped(FILE_SEARCH_OWNER),
  'FileShareController.list': own('a member gets only their own links; usage counts and the built-in File Share connector'),
  'FileShareController.revoke': ownerOrAdmin('FileShareService.revoke'),
  'FileShareController.createConnector': admin('checked in the handler'),
  'FileShareController.describe': noSession('share token'),
  'FileShareController.download': noSession('share token'),
  'FileShareController.downloadInternal': noSession('share token, plus a signed-in member of the workspace'),
  'FileShareController.stream': noSession('signed download link'),
  'FileShareController.limits': config('limits and aggregate usage'),
  'FileUploadController.status': noSession('upload token'),
  'FileUploadController.put': noSession('upload token'),
  'FileUploadController.post': noSession('upload token'),
  'FileUploadController.download': noSession('signed download link'),

  // ── health ─────────────────────────────────────────────────────────────
  'HealthController.getServerInfo': noSession('public health'),
  'HealthController.check': noSession('public health'),
  'SentryVerifyController.verify': noSession('operator check'),
  'VersionController.getVersion': config('version'),

  // ── identity providers, SSO, SCIM ──────────────────────────────────────
  'IdentityProvidersController.list': admin(),
  'IdentityProvidersController.get': admin(),
  'IdentityProvidersController.create': admin(),
  'IdentityProvidersController.update': admin(),
  'IdentityProvidersController.remove': admin(),
  'IdentityProvidersController.listRoleMappings': admin(),
  'IdentityProvidersController.replaceRoleMappings': admin(),
  'IdentityProvidersController.setEnforceSso': admin(),
  'IdentityProvidersController.resyncRoles': admin(),
  'IdentityProvidersController.scimStatus': admin(),
  'IdentityProvidersController.setScim': admin(),
  'IdentityProvidersController.rotateScim': admin(),
  'IdentityProvidersController.removeScim': admin(),
  'IdentityProvidersController.test': admin(),
  'ScimController.serviceProviderConfig': noSession('SCIM bearer token of an identity provider'),
  'ScimController.resourceTypes': noSession('SCIM bearer token of an identity provider'),
  'ScimController.resourceType': noSession('SCIM bearer token of an identity provider'),
  'ScimController.schemas': noSession('SCIM bearer token of an identity provider'),
  'ScimController.schema': noSession('SCIM bearer token of an identity provider'),
  'ScimController.listUsers': noSession('SCIM bearer token of an identity provider'),
  'ScimController.getUser': noSession('SCIM bearer token of an identity provider'),
  'ScimController.createUser': noSession('SCIM bearer token of an identity provider'),
  'ScimController.replaceUser': noSession('SCIM bearer token of an identity provider'),
  'ScimController.patchUser': noSession('SCIM bearer token of an identity provider'),
  'ScimController.deleteUser': noSession('SCIM bearer token of an identity provider'),
  'ScimController.listGroups': noSession('SCIM bearer token of an identity provider'),
  'ScimController.getGroup': noSession('SCIM bearer token of an identity provider'),
  'ScimController.createGroup': noSession('SCIM bearer token of an identity provider'),
  'ScimController.replaceGroup': noSession('SCIM bearer token of an identity provider'),
  'ScimController.patchGroup': noSession('SCIM bearer token of an identity provider'),
  'ScimController.deleteGroup': noSession('SCIM bearer token of an identity provider'),
  'SsoController.start': noSession('SSO sign-in'),
  'SsoController.callback': noSession('SSO sign-in'),
  'SsoController.startLink': own(),
  'SsoController.unlink': own(),
  'SsoController.myProviders': config('the workspace\'s sign-in options, and whether the caller linked each'),
  'SsoController.exchange': noSession('one-time sign-in code'),

  // ── knowledge folders, knowledge graph, memory ─────────────────────────
  'KnowledgeFoldersController.list': roleGoverned('folders the caller\'s roles may see'),
  'KnowledgeFoldersController.create': roleGoverned('ADMIN or EDITOR'),
  'KnowledgeFoldersController.update': roleGoverned('ADMIN or EDITOR'),
  'KnowledgeFoldersController.remove': roleGoverned('ADMIN or EDITOR'),
  'KnowledgeFoldersController.setRoles': admin(),
  'KnowledgeFoldersController.move': roleGoverned('ADMIN or EDITOR'),
  'KgController.getGraph': adminWhenRestricted('nodes and links of every connector and tool'),
  'KgController.stats': roleGoverned('ADMIN or EDITOR; counts only'),
  'KgController.getSettings': roleGoverned('ADMIN or EDITOR; whether the graph is on'),
  'KgController.setSettings': admin(),
  'KgController.enrich': admin(),
  'KgController.listSkills': adminWhenRestricted('skills learned from every member\'s requests'),
  'KgController.createSkill': admin(),
  'KgController.generateSkills': admin(),
  'KgController.proposeFromErrors': admin(),
  'KgController.consolidateSkills': admin(),
  'KgController.applySkill': admin(),
  'KgController.dismissSkill': admin(),
  'KgController.updateSkill': admin(),
  'KgController.skillVersions': adminWhenRestricted('skills learned from every member\'s requests'),
  'KgController.getMyLearning': own(),
  'KgController.setMyLearning': own(),
  'KgController.setMembersLearning': admin(),
  'KgController.deleteSkill': admin(),
  'KgController.rebuild': admin(),
  'KgController.createNode': admin(),
  'KgController.createEdge': admin(),
  'KgController.updateEdge': admin(),
  'KgController.deleteEdge': admin(),
  'KgController.updateNode': admin(),
  'KgController.deleteNode': admin(),
  'MemoryController.status': roleGoverned('licence, the caller\'s memory access and the workspace settings'),
  'MemoryController.list': roleGoverned('personal: the caller\'s own; company: by memory access and folder roles'),
  'MemoryController.create': roleGoverned('personal: the caller\'s own; company: by memory access'),
  'MemoryController.update': roleGoverned('the caller\'s own item, or a curator'),
  'MemoryController.remove': roleGoverned('the caller\'s own item, or a curator'),
  'MemoryController.approve': roleGoverned('ADMIN or EDITOR curators'),
  'MemoryController.reject': roleGoverned('ADMIN or EDITOR curators'),
  'MemoryController.updateSettings': admin(),
  'MemoryController.setAccess': admin(),
  'MemoryController.erasePersonal': admin(),

  // ── licence ────────────────────────────────────────────────────────────
  'LicenseController.getStatus': config('licence state'),
  'LicenseController.refresh': admin(),
  'LicenseController.syncFromSite': noSession('licence site, signed request'),
  'LicenseController.getInstanceId': config(),
  'LicenseController.getUsage': config('aggregate counts of connectors, servers and users'),
  'LicenseController.setLicenseKey': admin(),
  'LicenseController.billingPortal': admin(),
  'LicenseController.getInvoiceEmail': admin(),
  'LicenseController.setInvoiceEmail': admin(),
  'LicenseController.dpaLink': admin(),
  'LicenseController.checkoutLink': admin(),
  'LicenseController.pricingLinkToken': own('token for the caller\'s own address'),
  'LicenseController.cardTrialEligibilityForUser': admin(),
  'LicenseController.cardTrialOfferForUser': config('null for members who are not admins'),
  'LicenseController.planFitForUser': adminWhenRestricted('names every connector and MCP server of the workspace'),
  'LicenseController.wallForUser': admin('null unless the caller is an admin (checked in the handler)'),
  'LicenseController.verifyLicense': admin(),
  'LicenseController.activateTrial': config('starts the workspace trial; answers licence state'),
  'LicenseController.registerCommunity': admin(),
  'ReactivationController.view': noSession('reactivation token'),
  'ReactivationController.checkout': noSession('reactivation token'),
  'ReactivationController.event': noSession('reactivation token'),
  'TrialExtensionController.confirm': noSession('signed e-mail link'),
  'TrialExtensionController.extend': noSession('signed e-mail link'),

  // ── MCP endpoint ───────────────────────────────────────────────────────
  'McpEndpointController.handleGlobalPost': mcpRoles(),
  'McpEndpointController.handleGlobalGet': mcpRoles(),
  'McpEndpointController.handleGlobalDelete': mcpRoles(),
  'McpEndpointController.handleChatgptAppPost': mcpRoles(),
  'McpEndpointController.handleChatgptAppGet': mcpRoles(),
  'McpEndpointController.handleChatgptAppDelete': mcpRoles(),
  'McpEndpointController.handleFileSearchAppPost': mcpRoles(),
  'McpEndpointController.handleFileSearchAppGet': mcpRoles(),
  'McpEndpointController.handleFileSearchAppDelete': mcpRoles(),
  'McpEndpointController.handleDemoPost': mcpRoles(),
  'McpEndpointController.handleDemoGet': mcpRoles(),
  'McpEndpointController.handlePost': mcpRoles(),
  'McpEndpointController.handleGet': mcpRoles(),
  'McpEndpointController.handleDelete': mcpRoles(),
  'RegistryCatchUpController.catchUp': noSession('internal secret'),
  'WellKnownOAuthController.openaiAppsChallenge': noSession('public discovery'),
  'WellKnownOAuthController.openidConfiguration': noSession('public discovery'),
  'WellKnownOAuthController.openidConfigurationScoped': noSession('public discovery'),
  'WellKnownOAuthController.authorizationServerScoped': noSession('public discovery'),
  'WellKnownOAuthController.protectedResourceShared': noSession('public discovery'),
  'WellKnownOAuthController.protectedResourceScoped': noSession('public discovery'),

  // ── MCP servers and connections ────────────────────────────────────────
  'McpConnectionsController.list': own('the caller\'s grants; a granted server is named only when visible to them'),
  'McpConnectionsController.targets': scoped('per workspace, via McpConnectionGrantService: only own servers'),
  'McpConnectionsController.update': scoped('via McpConnectionGrantService: a hidden server is dropped like an unknown id'),
  'McpConnectionsController.revoke': own(),
  'McpServersController.list': scoped('only servers the member owns, with only the connectors they can see'),
  'McpServersController.create': own('creates a server owned by the caller; refused to a VIEWER'),
  'McpServersController.get': scoped('404 unless the member owns the server'),
  'McpServersController.activity': scoped('404 unless the member owns the server'),
  'McpServersController.update': scoped('404 unless the member owns the server; then owner or admin'),
  'McpServersController.delete': scoped('404 unless the member owns the server; then owner or admin'),
  'McpServersController.assignConnectors': scoped('404 for a server not owned and for a connector the member cannot see'),

  // ── organizations ──────────────────────────────────────────────────────
  'OrganizationsController.listMine': own('the caller\'s memberships'),
  'OrganizationsController.getCurrent': config('the workspace row'),
  'OrganizationsController.updateCurrent': admin('checked in the handler'),
  'OrganizationsController.deleteCurrent': admin('checked in the handler'),
  'OrganizationsController.revokeWorkspaceSessions': admin('checked in the handler'),
  'OrganizationsController.switchOrg': own('switches the caller\'s active workspace'),
  'OrganizationsController.createOrg': own('creates a workspace the caller owns'),
  'PublicStatsController.getStats': noSession('public aggregate counts'),

  // ── roles and keys ─────────────────────────────────────────────────────
  'McpApiKeysController.listKeys': scoped('the caller\'s own keys; mcpServer null for a server they may not see'),
  'McpApiKeysController.generateKey': scoped('a key for a server the member may not see answers 404'),
  'McpApiKeysController.revokeKey': own(),
  'McpApiKeysController.deleteKey': own(),
  'RolesController.listRoles': admin(),
  'RolesController.createRole': admin(),
  'RolesController.getRole': admin(),
  'RolesController.updateRole': admin(),
  'RolesController.deleteRole': admin(),
  'RolesController.getToolAccess': admin(),
  'RolesController.setToolAccess': admin(),
  'RolesController.setToolRateLimits': admin(),
  'RolesController.assignRole': admin(),
  'RolesController.getAssignments': admin(),
  'RolesController.setAssignments': admin(),

  // ── settings ───────────────────────────────────────────────────────────
  'MemberVisibilityMemberController.getMemberVisibility': own('the mode and whether it narrows the caller'),
  'MemberVisibilityAdminController.setMemberVisibility': admin(),
  'SiteSettingsPublicController.getFooterLinks': noSession('public footer links'),
  'SiteSettingsMemberController.getFooterLinks': config('footer links'),
  'SiteSettingsAdminController.getSmtpConfig': admin(),
  'SiteSettingsAdminController.updateSmtpConfig': admin(),
  'SiteSettingsAdminController.deleteSmtpConfig': admin(),
  'SiteSettingsAdminController.testSmtp': admin(),
  'SiteSettingsAdminController.getFooterLinks': admin(),
  'SiteSettingsAdminController.updateFooterLinks': admin(),
  'SiteSettingsAdminController.getSsrfAllowedHosts': admin(),
  'SiteSettingsAdminController.setSsrfAllowedHosts': admin(),
  'UnsubscribeController.confirm': noSession('signed unsubscribe link'),
  'UnsubscribeController.unsubscribe': noSession('signed unsubscribe link'),

  // ── users ──────────────────────────────────────────────────────────────
  'UsersController.getProfile': own(),
  'UsersController.getOnboardingState': own(),
  'UsersController.updateOnboardingState': own(),
  'UsersController.updateProfile': own(),
  'UsersController.deleteSelf': own(),
  'UsersController.changePassword': own(),
  'UsersController.listUsers': admin(),
  'UsersController.listInvitations': admin(),
  'UsersController.deleteInvitation': admin(),
  'UsersController.updateRole': admin(),
  'UsersController.revokeUserSessions': admin(),
  'UsersController.deactivateUser': admin(),
  'UsersController.reactivateUser': admin(),
  'UsersController.deleteUser': admin(),
};

/** The decision for one handler, or undefined when none is registered. */
export function routeVisibility(controller: string, handler: string): RouteVisibility | undefined {
  return MEMBER_VISIBILITY_ROUTES[`${controller}.${handler}`];
}
