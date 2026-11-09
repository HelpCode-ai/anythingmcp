/**
 * The reactivation page's words in the seven languages of anythingmcp.com.
 * The page is reached from an AI chat by people who may never have opened
 * the dashboard, so it does not stop at the dashboard's three UI languages
 * (src/i18n/config.ts): it follows the visitor's own choice (the amcp_locale
 * cookie) or the browser's languages, else English.
 *
 * `{name}` is replaced by fmt(); `<tag>…</tag>` marks a link the page renders.
 */

export const PAGE_LANGS = ['en', 'de', 'it', 'es', 'zh', 'ja', 'ru'] as const;
export type PageLang = (typeof PAGE_LANGS)[number];

export interface ReactivateCopy {
  nav: { secureCheckout: string; signIn: string; openWorkspace: string };
  loading: string;
  workspace: string;
  paused: string;
  yourAi: string;
  title: string;
  bodyEnded: string;
  body: string;
  plans: {
    monthly: string;
    yearly: string;
    twoMonthsFree: string;
    mostPopular: string;
    starter: string;
    team: string;
    perMonth: string;
    perYear: string;
    yearlyEquiv: string;
    outgrown: string;
    pricesVat: string;
    pricesNoVat: string;
    pricesLocal: string;
    enterprise: string;
    /** The Telegram price test's Starter monthly offer (offer: {price}, {months}, {list}). */
    offerLabel: string;
    offerTerms: string;
  };
  cta: string;
  opening: string;
  checkoutFailed: string;
  chips: { cancel: string; stripe: string; noSetup: string };
  stats: { workspaces: string; toolCalls: string };
  badges: { claude: string; chatgpt: string; eu: string; gdpr: string; encrypted: string; openSource: string };
  worksWith: string;
  next: {
    title: string;
    payTitle: string;
    payBody: string;
    activeTitle: string;
    activeBody: string;
    backTitle: string;
    backBody: string;
  };
  why: { title: string; kept: string; cancel: string; support: string };
  footer: string;
  imprint: string;
  privacy: string;
  terms: string;
  expiredTitle: string;
  expiredBody: string;
  errorTitle: string;
  errorBody: string;
  signIn: string;
  activeTitle: string;
  paidTitle: string;
  activeBody: string;
  openDashboard: string;
  processingTitle: string;
  processingBody: string;
  processingSlow: string;
  paymentFailedTitle: string;
  paymentFailedBody: string;
}

const en: ReactivateCopy = {
  nav: { secureCheckout: 'Secure checkout with Stripe', signIn: 'Sign in', openWorkspace: 'Open your workspace' },
  loading: 'Loading your workspace…',
  workspace: 'Workspace',
  paused: '{client} connection paused',
  yourAi: 'your AI',
  title: 'Pick up where {client} left off',
  bodyEnded:
    'Your free trial ended on {date}. Your connectors and settings are all still here. Subscribe and {client} can use them again within a few minutes, with no new setup.',
  body: 'Your free trial has ended. Your connectors and settings are all still here. Subscribe and {client} can use them again within a few minutes, with no new setup.',
  plans: {
    monthly: 'Monthly',
    yearly: 'Yearly',
    twoMonthsFree: '2 months free',
    mostPopular: 'Most popular',
    starter: '5 connectors · 3 MCP servers · 1 user',
    team: '15 connectors · 10 MCP servers · up to 3 users',
    perMonth: '/month',
    perYear: '/year',
    yearlyEquiv: '≈ {price}/month',
    outgrown: 'Your workspace already uses more than this plan includes.',
    pricesVat: 'Prices in EUR, VAT included.',
    pricesNoVat: 'Prices in EUR.',
    pricesLocal: 'Prices in EUR, paid in {currency} at checkout.',
    enterprise: 'More users, single sign-on or SCIM? <link>Ask about Enterprise</link>',
    offerLabel: 'Offer for you',
    offerTerms: '{price}/month for your first {months} months, then {list}/month.',
  },
  cta: 'Subscribe to {plan}',
  opening: 'Opening secure checkout…',
  checkoutFailed: 'The checkout could not be opened right now. Please try again in a moment.',
  chips: { cancel: 'Cancel any time', stripe: 'Payment by Stripe', noSetup: 'No new setup' },
  stats: { workspaces: 'workspaces on AnythingMCP Cloud', toolCalls: 'AI tool calls last month' },
  badges: {
    claude: 'Listed in the Claude Directory',
    chatgpt: 'Listed in the ChatGPT Plugin Directory',
    eu: 'Hosted in Frankfurt, EU',
    gdpr: 'GDPR · DPA',
    encrypted: 'AES-256-GCM encryption',
    openSource: 'Open source',
  },
  worksWith: 'Works with',
  next: {
    title: 'What happens next',
    payTitle: 'Pay securely with Stripe',
    payBody: 'Card, SEPA Direct Debit and other methods. We never see your card details.',
    activeTitle: 'Your workspace switches back on',
    activeBody: 'Automatically, usually within two or three minutes. No sign-in, no licence key.',
    backTitle: 'Ask {client} again',
    backBody: 'Go back to your chat and repeat your request. Your connectors answer as before.',
  },
  why: {
    title: 'Why teams stay with AnythingMCP',
    kept: 'Everything you set up is kept: connectors, sign-ins and settings.',
    cancel: 'No minimum term on monthly plans. Cancel any time from the billing portal.',
    support: 'Questions before you subscribe? Write to <mail>support@anythingmcp.com</mail>.',
  },
  footer: 'AnythingMCP by helpcode.ai',
  imprint: 'Imprint',
  privacy: 'Privacy',
  terms: 'Terms',
  expiredTitle: 'This link has expired',
  expiredBody: "Reactivation links stay valid for 30 days. Sign in to see your workspace's plans.",
  errorTitle: 'Something went wrong',
  errorBody: 'We could not load this page. Please try again in a moment, or sign in to see your plans.',
  signIn: 'Sign in',
  activeTitle: 'This workspace is active',
  paidTitle: "Payment received, you're all set",
  activeBody: '{workspace} is active again. Go back to {client} and ask again: your connectors answer as before.',
  openDashboard: 'Open the dashboard',
  processingTitle: 'Confirming your payment…',
  processingBody: 'This usually takes two or three minutes. Keep this page open, or go back to your chat in a moment.',
  processingSlow:
    'Your payment is still being confirmed. If the workspace is not active in a few minutes, sign in or write to support@anythingmcp.com.',
  paymentFailedTitle: "Your last payment didn't go through",
  paymentFailedBody: 'Sign in and update your payment method: your subscription resumes as soon as the payment is taken.',
};

const de: ReactivateCopy = {
  nav: { secureCheckout: 'Sicherer Checkout mit Stripe', signIn: 'Anmelden', openWorkspace: 'Zum Workspace' },
  loading: 'Ihr Workspace wird geladen…',
  workspace: 'Workspace',
  paused: '{client}-Verbindung pausiert',
  yourAi: 'Ihre KI',
  title: 'Machen Sie dort weiter, wo {client} aufgehört hat',
  bodyEnded:
    'Ihre kostenlose Testphase ist am {date} abgelaufen. Ihre Connectoren und Einstellungen sind vollständig erhalten. Mit einem Abo kann {client} sie innerhalb weniger Minuten wieder nutzen, ohne neue Einrichtung.',
  body: 'Ihre kostenlose Testphase ist abgelaufen. Ihre Connectoren und Einstellungen sind vollständig erhalten. Mit einem Abo kann {client} sie innerhalb weniger Minuten wieder nutzen, ohne neue Einrichtung.',
  plans: {
    monthly: 'Monatlich',
    yearly: 'Jährlich',
    twoMonthsFree: '2 Monate gratis',
    mostPopular: 'Am beliebtesten',
    starter: '5 Connectoren · 3 MCP-Server · 1 Nutzer',
    team: '15 Connectoren · 10 MCP-Server · bis zu 3 Nutzer',
    perMonth: '/Monat',
    perYear: '/Jahr',
    yearlyEquiv: '≈ {price}/Monat',
    outgrown: 'Ihr Workspace nutzt bereits mehr, als dieser Tarif enthält.',
    pricesVat: 'Preise in EUR, inkl. MwSt.',
    pricesNoVat: 'Preise in EUR.',
    pricesLocal: 'Preise in EUR, Zahlung im Checkout in {currency}.',
    enterprise: 'Mehr Nutzer, Single Sign-on oder SCIM? <link>Enterprise anfragen</link>',
    offerLabel: 'Angebot für Sie',
    offerTerms: '{price}/Monat für die ersten {months} Monate, danach {list}/Monat.',
  },
  cta: '{plan} abonnieren',
  opening: 'Sicherer Checkout wird geöffnet…',
  checkoutFailed: 'Der Checkout konnte gerade nicht geöffnet werden. Bitte versuchen Sie es gleich noch einmal.',
  chips: { cancel: 'Jederzeit kündbar', stripe: 'Zahlung über Stripe', noSetup: 'Keine neue Einrichtung' },
  stats: { workspaces: 'Workspaces auf AnythingMCP Cloud', toolCalls: 'KI-Tool-Aufrufe im letzten Monat' },
  badges: {
    claude: 'Gelistet im Claude Directory',
    chatgpt: 'Gelistet im ChatGPT Plugin Directory',
    eu: 'Gehostet in Frankfurt, EU',
    gdpr: 'DSGVO · AVV',
    encrypted: 'AES-256-GCM-Verschlüsselung',
    openSource: 'Open Source',
  },
  worksWith: 'Funktioniert mit',
  next: {
    title: 'So geht es weiter',
    payTitle: 'Sicher mit Stripe bezahlen',
    payBody: 'Karte, SEPA-Lastschrift und weitere Methoden. Ihre Kartendaten sehen wir nie.',
    activeTitle: 'Ihr Workspace ist wieder aktiv',
    activeBody: 'Automatisch, meist innerhalb von zwei bis drei Minuten. Ohne Anmeldung, ohne Lizenzschlüssel.',
    backTitle: 'Fragen Sie {client} erneut',
    backBody: 'Gehen Sie zurück in Ihren Chat und wiederholen Sie die Anfrage. Ihre Connectoren antworten wie zuvor.',
  },
  why: {
    title: 'Warum Teams bei AnythingMCP bleiben',
    kept: 'Alles, was Sie eingerichtet haben, bleibt erhalten: Connectoren, Anmeldungen und Einstellungen.',
    cancel: 'Keine Mindestlaufzeit bei Monatsplänen. Jederzeit im Abrechnungsportal kündbar.',
    support: 'Fragen vor dem Abo? Schreiben Sie an <mail>support@anythingmcp.com</mail>.',
  },
  footer: 'AnythingMCP von helpcode.ai',
  imprint: 'Impressum',
  privacy: 'Datenschutz',
  terms: 'AGB',
  expiredTitle: 'Dieser Link ist abgelaufen',
  expiredBody: 'Reaktivierungslinks sind 30 Tage gültig. Melden Sie sich an, um die Tarife Ihres Workspace zu sehen.',
  errorTitle: 'Etwas ist schiefgelaufen',
  errorBody: 'Die Seite konnte nicht geladen werden. Bitte versuchen Sie es gleich noch einmal oder melden Sie sich an.',
  signIn: 'Anmelden',
  activeTitle: 'Dieser Workspace ist aktiv',
  paidTitle: 'Zahlung erhalten, alles erledigt',
  activeBody: '{workspace} ist wieder aktiv. Gehen Sie zurück zu {client} und fragen Sie erneut: Ihre Connectoren antworten wie zuvor.',
  openDashboard: 'Dashboard öffnen',
  processingTitle: 'Ihre Zahlung wird bestätigt…',
  processingBody: 'Das dauert meist zwei bis drei Minuten. Lassen Sie diese Seite offen oder kehren Sie gleich zu Ihrem Chat zurück.',
  processingSlow:
    'Ihre Zahlung wird noch bestätigt. Ist der Workspace in ein paar Minuten nicht aktiv, melden Sie sich an oder schreiben Sie an support@anythingmcp.com.',
  paymentFailedTitle: 'Ihre letzte Zahlung ist fehlgeschlagen',
  paymentFailedBody: 'Melden Sie sich an und aktualisieren Sie Ihre Zahlungsmethode: Das Abo läuft weiter, sobald die Zahlung eingegangen ist.',
};

const it: ReactivateCopy = {
  nav: { secureCheckout: 'Checkout sicuro con Stripe', signIn: 'Accedi', openWorkspace: 'Vai al workspace' },
  loading: 'Caricamento del workspace…',
  workspace: 'Workspace',
  paused: 'Connessione con {client} in pausa',
  yourAi: 'la tua AI',
  title: 'Riprendi da dove {client} si è fermato',
  bodyEnded:
    'La tua prova gratuita è terminata il {date}. Connettori e impostazioni sono ancora tutti qui. Abbonati e {client} potrà usarli di nuovo in pochi minuti, senza rifare la configurazione.',
  body: 'La tua prova gratuita è terminata. Connettori e impostazioni sono ancora tutti qui. Abbonati e {client} potrà usarli di nuovo in pochi minuti, senza rifare la configurazione.',
  plans: {
    monthly: 'Mensile',
    yearly: 'Annuale',
    twoMonthsFree: '2 mesi gratis',
    mostPopular: 'Il più scelto',
    starter: '5 connettori · 3 server MCP · 1 utente',
    team: '15 connettori · 10 server MCP · fino a 3 utenti',
    perMonth: '/mese',
    perYear: '/anno',
    yearlyEquiv: '≈ {price}/mese',
    outgrown: 'Il tuo workspace usa già più di quanto includa questo piano.',
    pricesVat: 'Prezzi in EUR, IVA inclusa.',
    pricesNoVat: 'Prezzi in EUR.',
    pricesLocal: 'Prezzi in EUR, pagamento in {currency} al checkout.',
    enterprise: 'Più utenti, single sign-on o SCIM? <link>Chiedi di Enterprise</link>',
    offerLabel: 'Offerta per te',
    offerTerms: '{price}/mese per i primi {months} mesi, poi {list}/mese.',
  },
  cta: 'Abbonati a {plan}',
  opening: 'Apertura del checkout sicuro…',
  checkoutFailed: 'Non è stato possibile aprire il checkout. Riprova tra un momento.',
  chips: { cancel: 'Disdici quando vuoi', stripe: 'Pagamento con Stripe', noSetup: 'Nessuna nuova configurazione' },
  stats: { workspaces: 'workspace su AnythingMCP Cloud', toolCalls: 'chiamate AI ai tool nell’ultimo mese' },
  badges: {
    claude: 'Presente nella Claude Directory',
    chatgpt: 'Presente nella ChatGPT Plugin Directory',
    eu: 'Ospitato a Francoforte, UE',
    gdpr: 'GDPR · DPA',
    encrypted: 'Crittografia AES-256-GCM',
    openSource: 'Open source',
  },
  worksWith: 'Funziona con',
  next: {
    title: 'Cosa succede dopo',
    payTitle: 'Paghi in sicurezza con Stripe',
    payBody: 'Carta, addebito SEPA e altri metodi. Non vediamo mai i dati della tua carta.',
    activeTitle: 'Il workspace si riattiva',
    activeBody: 'In automatico, di solito in due o tre minuti. Senza login, senza chiave di licenza.',
    backTitle: 'Chiedi di nuovo a {client}',
    backBody: 'Torna nella tua chat e ripeti la richiesta. I tuoi connettori rispondono come prima.',
  },
  why: {
    title: 'Perché i team restano con AnythingMCP',
    kept: 'Tutto quello che hai configurato resta: connettori, accessi e impostazioni.',
    cancel: 'Nessun vincolo sui piani mensili. Disdici quando vuoi dal portale di fatturazione.',
    support: 'Domande prima di abbonarti? Scrivi a <mail>support@anythingmcp.com</mail>.',
  },
  footer: 'AnythingMCP di helpcode.ai',
  imprint: 'Impressum',
  privacy: 'Privacy',
  terms: 'Termini',
  expiredTitle: 'Questo link è scaduto',
  expiredBody: 'I link di riattivazione valgono 30 giorni. Accedi per vedere i piani del tuo workspace.',
  errorTitle: 'Qualcosa è andato storto',
  errorBody: 'Non siamo riusciti a caricare la pagina. Riprova tra un momento, oppure accedi per vedere i piani.',
  signIn: 'Accedi',
  activeTitle: 'Questo workspace è attivo',
  paidTitle: 'Pagamento ricevuto, è tutto pronto',
  activeBody: '{workspace} è di nuovo attivo. Torna su {client} e ripeti la richiesta: i tuoi connettori rispondono come prima.',
  openDashboard: 'Apri la dashboard',
  processingTitle: 'Stiamo confermando il pagamento…',
  processingBody: 'Di solito ci vogliono due o tre minuti. Lascia aperta questa pagina, oppure torna alla tua chat tra un momento.',
  processingSlow:
    'Il pagamento è ancora in conferma. Se il workspace non è attivo tra qualche minuto, accedi o scrivi a support@anythingmcp.com.',
  paymentFailedTitle: "L'ultimo pagamento non è andato a buon fine",
  paymentFailedBody: "Accedi e aggiorna il metodo di pagamento: l'abbonamento riprende appena il pagamento viene incassato.",
};

const es: ReactivateCopy = {
  nav: { secureCheckout: 'Pago seguro con Stripe', signIn: 'Iniciar sesión', openWorkspace: 'Ir a tu workspace' },
  loading: 'Cargando tu workspace…',
  workspace: 'Workspace',
  paused: 'Conexión con {client} en pausa',
  yourAi: 'tu IA',
  title: 'Retoma donde {client} lo dejó',
  bodyEnded:
    'Tu prueba gratuita terminó el {date}. Tus conectores y ajustes siguen aquí. Suscríbete y {client} podrá volver a usarlos en pocos minutos, sin configurar nada de nuevo.',
  body: 'Tu prueba gratuita ha terminado. Tus conectores y ajustes siguen aquí. Suscríbete y {client} podrá volver a usarlos en pocos minutos, sin configurar nada de nuevo.',
  plans: {
    monthly: 'Mensual',
    yearly: 'Anual',
    twoMonthsFree: '2 meses gratis',
    mostPopular: 'El más elegido',
    starter: '5 conectores · 3 servidores MCP · 1 usuario',
    team: '15 conectores · 10 servidores MCP · hasta 3 usuarios',
    perMonth: '/mes',
    perYear: '/año',
    yearlyEquiv: '≈ {price}/mes',
    outgrown: 'Tu workspace ya usa más de lo que incluye este plan.',
    pricesVat: 'Precios en EUR, IVA incluido.',
    pricesNoVat: 'Precios en EUR.',
    pricesLocal: 'Precios en EUR; pagas en {currency} en el checkout.',
    enterprise: '¿Más usuarios, inicio de sesión único o SCIM? <link>Consulta Enterprise</link>',
    offerLabel: 'Oferta para ti',
    offerTerms: '{price}/mes durante los primeros {months} meses, después {list}/mes.',
  },
  cta: 'Suscribirse a {plan}',
  opening: 'Abriendo el pago seguro…',
  checkoutFailed: 'No se pudo abrir el pago en este momento. Inténtalo de nuevo en un momento.',
  chips: { cancel: 'Cancela cuando quieras', stripe: 'Pago con Stripe', noSetup: 'Sin volver a configurar' },
  stats: { workspaces: 'workspaces en AnythingMCP Cloud', toolCalls: 'llamadas de IA a herramientas el último mes' },
  badges: {
    claude: 'En el Claude Directory',
    chatgpt: 'En el ChatGPT Plugin Directory',
    eu: 'Alojado en Fráncfort, UE',
    gdpr: 'RGPD · DPA',
    encrypted: 'Cifrado AES-256-GCM',
    openSource: 'Código abierto',
  },
  worksWith: 'Funciona con',
  next: {
    title: 'Qué pasa después',
    payTitle: 'Pagas de forma segura con Stripe',
    payBody: 'Tarjeta, adeudo directo SEPA y otros métodos. Nunca vemos los datos de tu tarjeta.',
    activeTitle: 'Tu workspace se reactiva',
    activeBody: 'Automáticamente, normalmente en dos o tres minutos. Sin iniciar sesión, sin clave de licencia.',
    backTitle: 'Vuelve a preguntar a {client}',
    backBody: 'Vuelve a tu chat y repite tu petición. Tus conectores responden como antes.',
  },
  why: {
    title: 'Por qué los equipos se quedan con AnythingMCP',
    kept: 'Todo lo que configuraste se conserva: conectores, accesos y ajustes.',
    cancel: 'Sin permanencia en los planes mensuales. Cancela cuando quieras desde el portal de facturación.',
    support: '¿Dudas antes de suscribirte? Escribe a <mail>support@anythingmcp.com</mail>.',
  },
  footer: 'AnythingMCP de helpcode.ai',
  imprint: 'Aviso legal',
  privacy: 'Privacidad',
  terms: 'Términos',
  expiredTitle: 'Este enlace ha caducado',
  expiredBody: 'Los enlaces de reactivación son válidos 30 días. Inicia sesión para ver los planes de tu workspace.',
  errorTitle: 'Algo salió mal',
  errorBody: 'No pudimos cargar esta página. Inténtalo de nuevo en un momento o inicia sesión para ver los planes.',
  signIn: 'Iniciar sesión',
  activeTitle: 'Este workspace está activo',
  paidTitle: 'Pago recibido, todo listo',
  activeBody: '{workspace} vuelve a estar activo. Vuelve a {client} y pregunta de nuevo: tus conectores responden como antes.',
  openDashboard: 'Abrir el panel',
  processingTitle: 'Confirmando tu pago…',
  processingBody: 'Normalmente tarda dos o tres minutos. Deja esta página abierta o vuelve a tu chat en un momento.',
  processingSlow:
    'Tu pago aún se está confirmando. Si el workspace no está activo en unos minutos, inicia sesión o escribe a support@anythingmcp.com.',
  paymentFailedTitle: 'Tu último pago no se completó',
  paymentFailedBody: 'Inicia sesión y actualiza tu método de pago: la suscripción se reanuda en cuanto se cobre el pago.',
};

const zh: ReactivateCopy = {
  nav: { secureCheckout: '通过 Stripe 安全结账', signIn: '登录', openWorkspace: '进入工作区' },
  loading: '正在加载你的工作区…',
  workspace: '工作区',
  paused: '{client} 连接已暂停',
  yourAi: '你的 AI',
  title: '让 {client} 从中断处继续',
  bodyEnded: '你的免费试用已于 {date} 结束。你的连接器和设置都还在。订阅后，{client} 几分钟内即可重新使用它们，无需重新配置。',
  body: '你的免费试用已结束。你的连接器和设置都还在。订阅后，{client} 几分钟内即可重新使用它们，无需重新配置。',
  plans: {
    monthly: '按月',
    yearly: '按年',
    twoMonthsFree: '免费 2 个月',
    mostPopular: '最受欢迎',
    starter: '5 个连接器 · 3 个 MCP 服务器 · 1 位用户',
    team: '15 个连接器 · 10 个 MCP 服务器 · 最多 3 位用户',
    perMonth: '/月',
    perYear: '/年',
    yearlyEquiv: '≈ {price}/月',
    outgrown: '你的工作区当前用量已超出此套餐。',
    pricesVat: '价格以欧元计，含增值税。',
    pricesNoVat: '价格以欧元计。',
    pricesLocal: '价格以欧元计，结账时以 {currency} 支付。',
    enterprise: '需要更多用户、单点登录或 SCIM？<link>咨询企业版</link>',
    offerLabel: '专属优惠',
    offerTerms: '前 {months} 个月每月 {price}，之后每月 {list}。',
  },
  cta: '订阅 {plan}',
  opening: '正在打开安全结账…',
  checkoutFailed: '暂时无法打开结账页面，请稍后再试。',
  chips: { cancel: '随时取消', stripe: '由 Stripe 处理付款', noSetup: '无需重新配置' },
  stats: { workspaces: '个工作区在使用 AnythingMCP Cloud', toolCalls: '次 AI 工具调用（上个月）' },
  badges: {
    claude: '已上架 Claude Directory',
    chatgpt: '已上架 ChatGPT Plugin Directory',
    eu: '托管于欧盟法兰克福',
    gdpr: 'GDPR · DPA',
    encrypted: 'AES-256-GCM 加密',
    openSource: '开源',
  },
  worksWith: '支持',
  next: {
    title: '接下来会发生什么',
    payTitle: '通过 Stripe 安全付款',
    payBody: '支持银行卡、SEPA 直接借记等方式。我们看不到你的卡信息。',
    activeTitle: '工作区自动恢复',
    activeBody: '通常在两三分钟内自动完成。无需登录，无需许可证密钥。',
    backTitle: '再次询问 {client}',
    backBody: '回到你的对话，重复你的请求。你的连接器会像以前一样响应。',
  },
  why: {
    title: '为什么团队选择继续使用 AnythingMCP',
    kept: '你配置的一切都会保留：连接器、登录和设置。',
    cancel: '月付套餐无最短期限，可随时在账单门户中取消。',
    support: '订阅前有疑问？请写信至 <mail>support@anythingmcp.com</mail>。',
  },
  footer: 'AnythingMCP，由 helpcode.ai 提供',
  imprint: '法律声明',
  privacy: '隐私',
  terms: '条款',
  expiredTitle: '此链接已过期',
  expiredBody: '重新激活链接的有效期为 30 天。请登录查看你的工作区套餐。',
  errorTitle: '出了点问题',
  errorBody: '无法加载此页面。请稍后再试，或登录查看套餐。',
  signIn: '登录',
  activeTitle: '此工作区已激活',
  paidTitle: '已收到付款，一切就绪',
  activeBody: '{workspace} 已重新激活。回到 {client} 再问一次：你的连接器会像以前一样响应。',
  openDashboard: '打开控制台',
  processingTitle: '正在确认你的付款…',
  processingBody: '通常需要两三分钟。你可以保持此页面打开，或稍后回到你的对话。',
  processingSlow: '你的付款仍在确认中。如果几分钟后工作区仍未激活，请登录或写信至 support@anythingmcp.com。',
  paymentFailedTitle: '你的上一笔付款未成功',
  paymentFailedBody: '请登录并更新付款方式：付款成功后订阅会立即恢复。',
};

const ja: ReactivateCopy = {
  nav: { secureCheckout: 'Stripe による安全な決済', signIn: 'ログイン', openWorkspace: 'ワークスペースを開く' },
  loading: 'ワークスペースを読み込み中…',
  workspace: 'ワークスペース',
  paused: '{client} との接続は一時停止中',
  yourAi: 'お使いの AI',
  title: '{client} の作業をそのまま再開',
  bodyEnded:
    '無料トライアルは {date} に終了しました。コネクタと設定はすべてそのまま残っています。サブスクリプションを開始すると、{client} は数分以内に再びそれらを使えるようになります。再設定は不要です。',
  body: '無料トライアルは終了しました。コネクタと設定はすべてそのまま残っています。サブスクリプションを開始すると、{client} は数分以内に再びそれらを使えるようになります。再設定は不要です。',
  plans: {
    monthly: '月払い',
    yearly: '年払い',
    twoMonthsFree: '2 か月分無料',
    mostPopular: '一番人気',
    starter: 'コネクタ 5 個 · MCP サーバー 3 台 · ユーザー 1 名',
    team: 'コネクタ 15 個 · MCP サーバー 10 台 · ユーザー最大 3 名',
    perMonth: '/月',
    perYear: '/年',
    yearlyEquiv: '月あたり約 {price}',
    outgrown: 'このワークスペースは、すでにこのプランの上限を超えて使用しています。',
    pricesVat: '価格はユーロ建て、VAT 込みです。',
    pricesNoVat: '価格はユーロ建てです。',
    pricesLocal: '価格はユーロ建てで、決済時に {currency} でお支払いいただきます。',
    enterprise: 'ユーザー追加、シングルサインオン、SCIM が必要ですか？<link>Enterprise について問い合わせる</link>',
    offerLabel: 'あなたへの特別価格',
    offerTerms: '最初の {months} か月は月額 {price}、その後は月額 {list}。',
  },
  cta: '{plan} に登録する',
  opening: '安全な決済ページを開いています…',
  checkoutFailed: '現在、決済ページを開けませんでした。しばらくしてからもう一度お試しください。',
  chips: { cancel: 'いつでも解約可能', stripe: 'Stripe で決済', noSetup: '再設定不要' },
  stats: { workspaces: 'AnythingMCP Cloud のワークスペース', toolCalls: '先月の AI ツール呼び出し' },
  badges: {
    claude: 'Claude Directory に掲載',
    chatgpt: 'ChatGPT Plugin Directory に掲載',
    eu: 'EU・フランクフルトでホスティング',
    gdpr: 'GDPR · DPA',
    encrypted: 'AES-256-GCM 暗号化',
    openSource: 'オープンソース',
  },
  worksWith: '対応クライアント',
  next: {
    title: 'この後の流れ',
    payTitle: 'Stripe で安全にお支払い',
    payBody: 'カード、SEPA 口座引き落としなどに対応。カード情報が当社に渡ることはありません。',
    activeTitle: 'ワークスペースが再び有効に',
    activeBody: '通常 2〜3 分以内に自動で有効になります。ログインもライセンスキーも不要です。',
    backTitle: 'もう一度 {client} に依頼',
    backBody: 'チャットに戻って同じ依頼を繰り返してください。コネクタは以前と同じように応答します。',
  },
  why: {
    title: 'チームが AnythingMCP を使い続ける理由',
    kept: '設定した内容はすべて保持されます：コネクタ、ログイン情報、設定。',
    cancel: '月払いプランに最低契約期間はありません。請求ポータルからいつでも解約できます。',
    support: 'ご登録前のご質問は <mail>support@anythingmcp.com</mail> までどうぞ。',
  },
  footer: 'AnythingMCP by helpcode.ai',
  imprint: '運営者情報',
  privacy: 'プライバシー',
  terms: '利用規約',
  expiredTitle: 'このリンクは有効期限切れです',
  expiredBody: '再有効化リンクの有効期間は 30 日です。ログインしてワークスペースのプランをご確認ください。',
  errorTitle: '問題が発生しました',
  errorBody: 'このページを読み込めませんでした。しばらくしてから再度お試しいただくか、ログインしてプランをご確認ください。',
  signIn: 'ログイン',
  activeTitle: 'このワークスペースは有効です',
  paidTitle: 'お支払いを受け付けました。準備完了です',
  activeBody: '{workspace} は再び有効になりました。{client} に戻ってもう一度依頼してください。コネクタは以前と同じように応答します。',
  openDashboard: 'ダッシュボードを開く',
  processingTitle: 'お支払いを確認しています…',
  processingBody: '通常 2〜3 分ほどかかります。このページを開いたままにするか、少ししてからチャットに戻ってください。',
  processingSlow:
    'お支払いはまだ確認中です。数分経ってもワークスペースが有効にならない場合は、ログインするか support@anythingmcp.com までご連絡ください。',
  paymentFailedTitle: '前回のお支払いが完了しませんでした',
  paymentFailedBody: 'ログインしてお支払い方法を更新してください。お支払いが完了するとサブスクリプションはすぐに再開されます。',
};

const ru: ReactivateCopy = {
  nav: { secureCheckout: 'Безопасная оплата через Stripe', signIn: 'Войти', openWorkspace: 'Открыть workspace' },
  loading: 'Загружаем ваш workspace…',
  workspace: 'Workspace',
  paused: 'Подключение {client} приостановлено',
  yourAi: 'ваш ИИ',
  title: 'Продолжите с того места, где остановился {client}',
  bodyEnded:
    'Ваш бесплатный пробный период закончился {date}. Все коннекторы и настройки сохранены. Оформите подписку, и {client} снова сможет ими пользоваться уже через несколько минут, без повторной настройки.',
  body: 'Ваш бесплатный пробный период закончился. Все коннекторы и настройки сохранены. Оформите подписку, и {client} снова сможет ими пользоваться уже через несколько минут, без повторной настройки.',
  plans: {
    monthly: 'Помесячно',
    yearly: 'Ежегодно',
    twoMonthsFree: '2 месяца бесплатно',
    mostPopular: 'Самый популярный',
    starter: '5 коннекторов · 3 MCP-сервера · 1 пользователь',
    team: '15 коннекторов · 10 MCP-серверов · до 3 пользователей',
    perMonth: '/мес.',
    perYear: '/год',
    yearlyEquiv: '≈ {price}/мес.',
    outgrown: 'Ваш workspace уже использует больше, чем входит в этот тариф.',
    pricesVat: 'Цены в евро, включая НДС.',
    pricesNoVat: 'Цены в евро.',
    pricesLocal: 'Цены в евро, оплата при оформлении в {currency}.',
    enterprise: 'Нужно больше пользователей, единый вход или SCIM? <link>Узнать об Enterprise</link>',
    offerLabel: 'Предложение для вас',
    offerTerms: '{price}/мес. первые {months} месяцев, затем {list}/мес.',
  },
  cta: 'Подписаться на {plan}',
  opening: 'Открываем безопасную оплату…',
  checkoutFailed: 'Не удалось открыть страницу оплаты. Попробуйте ещё раз через минуту.',
  chips: { cancel: 'Отмена в любой момент', stripe: 'Оплата через Stripe', noSetup: 'Без повторной настройки' },
  stats: { workspaces: 'workspace в AnythingMCP Cloud', toolCalls: 'вызовов инструментов ИИ за прошлый месяц' },
  badges: {
    claude: 'В каталоге Claude Directory',
    chatgpt: 'В каталоге ChatGPT Plugin Directory',
    eu: 'Хостинг во Франкфурте, ЕС',
    gdpr: 'GDPR · DPA',
    encrypted: 'Шифрование AES-256-GCM',
    openSource: 'Открытый исходный код',
  },
  worksWith: 'Работает с',
  next: {
    title: 'Что будет дальше',
    payTitle: 'Безопасная оплата через Stripe',
    payBody: 'Карта, прямое списание SEPA и другие способы. Мы никогда не видим данные вашей карты.',
    activeTitle: 'Workspace снова включится',
    activeBody: 'Автоматически, обычно в течение двух-трёх минут. Без входа и без лицензионного ключа.',
    backTitle: 'Спросите {client} ещё раз',
    backBody: 'Вернитесь в чат и повторите запрос. Коннекторы ответят, как раньше.',
  },
  why: {
    title: 'Почему команды остаются с AnythingMCP',
    kept: 'Всё, что вы настроили, сохраняется: коннекторы, входы и настройки.',
    cancel: 'Без минимального срока на помесячных тарифах. Отменить можно в любой момент в платёжном портале.',
    support: 'Есть вопросы до оформления подписки? Напишите на <mail>support@anythingmcp.com</mail>.',
  },
  footer: 'AnythingMCP от helpcode.ai',
  imprint: 'Выходные данные',
  privacy: 'Конфиденциальность',
  terms: 'Условия',
  expiredTitle: 'Срок действия ссылки истёк',
  expiredBody: 'Ссылки для повторной активации действуют 30 дней. Войдите, чтобы посмотреть тарифы вашего workspace.',
  errorTitle: 'Что-то пошло не так',
  errorBody: 'Не удалось загрузить страницу. Попробуйте ещё раз через минуту или войдите, чтобы посмотреть тарифы.',
  signIn: 'Войти',
  activeTitle: 'Этот workspace активен',
  paidTitle: 'Оплата получена, всё готово',
  activeBody: '{workspace} снова активен. Вернитесь в {client} и повторите запрос: коннекторы ответят, как раньше.',
  openDashboard: 'Открыть панель управления',
  processingTitle: 'Подтверждаем оплату…',
  processingBody: 'Обычно это занимает две-три минуты. Оставьте страницу открытой или вернитесь в чат чуть позже.',
  processingSlow:
    'Оплата ещё подтверждается. Если через несколько минут workspace не станет активным, войдите или напишите на support@anythingmcp.com.',
  paymentFailedTitle: 'Последний платёж не прошёл',
  paymentFailedBody: 'Войдите и обновите способ оплаты: подписка возобновится, как только платёж пройдёт.',
};

export const COPY: Record<PageLang, ReactivateCopy> = { en, de, it, es, zh, ja, ru };

/** The BCP 47 tag used to format dates in each page language. */
export const DATE_LOCALE: Record<PageLang, string> = {
  en: 'en-GB',
  de: 'de-DE',
  it: 'it-IT',
  es: 'es-ES',
  zh: 'zh-CN',
  ja: 'ja-JP',
  ru: 'ru-RU',
};

function asPageLang(value: string | null | undefined): PageLang | null {
  const primary = (value ?? '').trim().toLowerCase().split(/[-_]/)[0];
  return (PAGE_LANGS as readonly string[]).includes(primary) ? (primary as PageLang) : null;
}

/**
 * The page's language: the dashboard language the visitor picked (the
 * amcp_locale cookie), else the first of the browser's languages the page
 * has, else English.
 */
export function pickPageLang(cookie: string, browserLanguages: readonly string[]): PageLang {
  const chosen = asPageLang(/(?:^|;\s*)amcp_locale=([^;]+)/.exec(cookie)?.[1]);
  if (chosen) return chosen;
  for (const lang of browserLanguages) {
    const match = asPageLang(lang);
    if (match) return match;
  }
  return 'en';
}

/** `template` with each `{name}` replaced by `vars[name]`. */
export function fmt(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

/**
 * Splits `text` around one `<tag>…</tag>`: [before, inside, after], or null
 * when the tag is missing.
 */
export function splitTag(text: string, tag: string): [string, string, string] | null {
  const m = new RegExp(`^([\\s\\S]*)<${tag}>([\\s\\S]*)</${tag}>([\\s\\S]*)$`).exec(text);
  return m ? [m[1], m[2], m[3]] : null;
}
