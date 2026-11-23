import type { PageLanguage } from './authorization-attempt';

/**
 * The texts of the sign-in / consent page (`/auth/login` inside an
 * authorization) in the seven languages of the trial pages. Used by the
 * `buttons_first` arm of the sign-in page test only; the control page stays
 * in English.
 *
 * The other pages of the flow have their dictionaries next to this file:
 * `auth-page-i18n.steps.ts` (code step, server picker, the messages shown on
 * the sign-in page), `auth-page-i18n.connected.ts` (the page after
 * approving), `auth-page-i18n.telegram.ts` (its one-tap Telegram panel) and
 * `auth-page-i18n.pages.ts` (request closed, rate limit, cancelled, File
 * Search). Every language object is typed with its interface, so a key
 * missing in one language does not compile.
 *
 * Placeholders in braces are replaced by `fill`. Every value put into a
 * placeholder must already be HTML-escaped by the caller; the texts
 * themselves contain only the markup written here (<strong>, <b>).
 */
export interface SignInTexts {
  heading: string; // {client} {server}
  subSignedIn: string; // {client} {server}
  subSignedOut: string; // {client} {server}
  /** One line on what the person gets (A4). */
  value: string; // {client}
  canDo: string; // {client}
  tools: string;
  toolsOn: string; // {server} (already wrapped in <b>)
  readProfile: string;
  noSecrets: string;
  scope: string;
  sentIfAllow: string; // {host}
  sentAfterSignIn: string; // {host}
  warn: string; // {cancel}
  cancel: string;
  signInAllow: string;
  allow: string;
  signedInAs: string; // {email}
  switchAccount: string;
  continueWith: string; // {provider}
  terms: string; // {terms} {privacy}
  termsLabel: string;
  privacyLabel: string;
  orEmail: string;
  email: string;
  password: string;
  passwordPlaceholder: string;
  forgot: string;
  noAccount: string;
  createWithEmail: string;
  titleSignIn: string;
  titleAuthorize: string;
}

const EN: SignInTexts = {
  heading: 'Connect {client} to {server}',
  subSignedIn: '{client} will use the tools your role allows on {server}. You stay in control and can disconnect at any time.',
  subSignedOut: 'Sign in to let {client} use your {server} tools. You stay in control and can disconnect at any time.',
  value: 'Then {client} works with the apps you use, such as Telegram, Etsy, WooCommerce or Odoo. Start free, no card needed.',
  canDo: '{client} will be able to',
  tools: 'Use the tools on your MCP server that your role allows',
  toolsOn: 'Use the tools on {server} that your role allows',
  readProfile: 'Read your name and email address',
  noSecrets: 'It never sees your connector passwords or API keys',
  scope: 'Requested scope:',
  sentIfAllow: 'If you allow it, access is sent to {host}',
  sentAfterSignIn: 'After you sign in, access is sent to {host}',
  warn: 'Only continue if you started this and recognise this destination. If you did not, choose <strong>{cancel}</strong>.',
  cancel: 'Cancel',
  signInAllow: 'Sign in &amp; allow',
  allow: 'Allow access',
  signedInAs: 'Signed in as {email}',
  switchAccount: 'Switch account',
  continueWith: 'Continue with {provider}',
  terms: 'New here? Continuing creates your account and accepts the {terms} and {privacy}.',
  termsLabel: 'Terms',
  privacyLabel: 'Privacy Policy',
  orEmail: 'or use your email',
  email: 'Email',
  password: 'Password',
  passwordPlaceholder: 'Your password',
  forgot: 'Forgot your password?',
  noAccount: 'No account yet? The buttons above create one.',
  createWithEmail: 'Create an account with email',
  titleSignIn: 'Sign In',
  titleAuthorize: 'Authorize',
};

const DE: SignInTexts = {
  heading: '{client} mit {server} verbinden',
  subSignedIn: '{client} nutzt die Tools, die Ihre Rolle auf {server} erlaubt. Sie behalten die Kontrolle und können die Verbindung jederzeit trennen.',
  subSignedOut: 'Melden Sie sich an, damit {client} Ihre {server}-Tools nutzen kann. Sie behalten die Kontrolle und können die Verbindung jederzeit trennen.',
  value: 'Danach arbeitet {client} mit Ihren Apps, zum Beispiel Telegram, Etsy, WooCommerce oder Odoo. Kostenlos starten, ohne Karte.',
  canDo: '{client} kann dann',
  tools: 'die Tools Ihres MCP-Servers nutzen, die Ihre Rolle erlaubt',
  toolsOn: 'die Tools auf {server} nutzen, die Ihre Rolle erlaubt',
  readProfile: 'Ihren Namen und Ihre E-Mail-Adresse lesen',
  noSecrets: 'Ihre Connector-Passwörter und API-Schlüssel sieht es nie',
  scope: 'Angefragter Umfang:',
  sentIfAllow: 'Wenn Sie zustimmen, geht der Zugang an {host}',
  sentAfterSignIn: 'Nach der Anmeldung geht der Zugang an {host}',
  warn: 'Fahren Sie nur fort, wenn Sie das selbst gestartet haben und dieses Ziel kennen. Andernfalls wählen Sie <strong>{cancel}</strong>.',
  cancel: 'Abbrechen',
  signInAllow: 'Anmelden &amp; zulassen',
  allow: 'Zugriff erlauben',
  signedInAs: 'Angemeldet als {email}',
  switchAccount: 'Konto wechseln',
  continueWith: 'Weiter mit {provider}',
  terms: 'Neu hier? Wenn Sie fortfahren, wird Ihr Konto erstellt und Sie akzeptieren die {terms} und die {privacy}.',
  termsLabel: 'AGB',
  privacyLabel: 'Datenschutzerklärung',
  orEmail: 'oder mit E-Mail',
  email: 'E-Mail',
  password: 'Passwort',
  passwordPlaceholder: 'Ihr Passwort',
  forgot: 'Passwort vergessen?',
  noAccount: 'Noch kein Konto? Die Schaltflächen oben erstellen eines.',
  createWithEmail: 'Konto mit E-Mail erstellen',
  titleSignIn: 'Anmelden',
  titleAuthorize: 'Zugriff erlauben',
};

const IT: SignInTexts = {
  heading: 'Collega {client} a {server}',
  subSignedIn: '{client} userà gli strumenti che il tuo ruolo consente su {server}. Mantieni il controllo e puoi scollegarlo in qualsiasi momento.',
  subSignedOut: 'Accedi per permettere a {client} di usare i tuoi strumenti {server}. Mantieni il controllo e puoi scollegarlo in qualsiasi momento.',
  value: 'Poi {client} lavora con le app che usi, come Telegram, Etsy, WooCommerce o Odoo. Inizi gratis, senza carta.',
  canDo: '{client} potrà',
  tools: 'usare gli strumenti del tuo server MCP che il tuo ruolo consente',
  toolsOn: 'usare gli strumenti su {server} che il tuo ruolo consente',
  readProfile: 'leggere il tuo nome e il tuo indirizzo email',
  noSecrets: 'Non vede mai le password o le chiavi API dei tuoi connettori',
  scope: 'Ambito richiesto:',
  sentIfAllow: 'Se lo consenti, l’accesso viene inviato a {host}',
  sentAfterSignIn: 'Dopo l’accesso, l’accesso viene inviato a {host}',
  warn: 'Continua solo se hai avviato tu questa richiesta e riconosci questa destinazione. Altrimenti scegli <strong>{cancel}</strong>.',
  cancel: 'Annulla',
  signInAllow: 'Accedi e consenti',
  allow: 'Consenti l’accesso',
  signedInAs: 'Accesso come {email}',
  switchAccount: 'Cambia account',
  continueWith: 'Continua con {provider}',
  terms: 'Sei nuovo? Continuando crei il tuo account e accetti i {terms} e l’{privacy}.',
  termsLabel: 'Termini',
  privacyLabel: 'Informativa sulla privacy',
  orEmail: 'oppure usa la tua email',
  email: 'Email',
  password: 'Password',
  passwordPlaceholder: 'La tua password',
  forgot: 'Password dimenticata?',
  noAccount: 'Non hai ancora un account? I pulsanti qui sopra ne creano uno.',
  createWithEmail: 'Crea un account con l’email',
  titleSignIn: 'Accedi',
  titleAuthorize: 'Consenti l’accesso',
};

const ES: SignInTexts = {
  heading: 'Conecta {client} con {server}',
  subSignedIn: '{client} usará las herramientas que tu rol permite en {server}. Mantienes el control y puedes desconectarlo cuando quieras.',
  subSignedOut: 'Inicia sesión para que {client} use tus herramientas de {server}. Mantienes el control y puedes desconectarlo cuando quieras.',
  value: 'Después, {client} trabaja con las apps que usas, como Telegram, Etsy, WooCommerce u Odoo. Empieza gratis, sin tarjeta.',
  canDo: '{client} podrá',
  tools: 'usar las herramientas de tu servidor MCP que tu rol permite',
  toolsOn: 'usar las herramientas de {server} que tu rol permite',
  readProfile: 'leer tu nombre y tu dirección de correo',
  noSecrets: 'Nunca ve las contraseñas ni las claves API de tus conectores',
  scope: 'Alcance solicitado:',
  sentIfAllow: 'Si lo permites, el acceso se envía a {host}',
  sentAfterSignIn: 'Tras iniciar sesión, el acceso se envía a {host}',
  warn: 'Continúa solo si iniciaste tú esta solicitud y reconoces este destino. Si no, elige <strong>{cancel}</strong>.',
  cancel: 'Cancelar',
  signInAllow: 'Iniciar sesión y permitir',
  allow: 'Permitir acceso',
  signedInAs: 'Sesión iniciada como {email}',
  switchAccount: 'Cambiar de cuenta',
  continueWith: 'Continuar con {provider}',
  terms: '¿Eres nuevo? Al continuar se crea tu cuenta y aceptas los {terms} y la {privacy}.',
  termsLabel: 'Términos',
  privacyLabel: 'Política de privacidad',
  orEmail: 'o usa tu correo',
  email: 'Correo electrónico',
  password: 'Contraseña',
  passwordPlaceholder: 'Tu contraseña',
  forgot: '¿Olvidaste tu contraseña?',
  noAccount: '¿Aún no tienes cuenta? Los botones de arriba crean una.',
  createWithEmail: 'Crear una cuenta con correo',
  titleSignIn: 'Iniciar sesión',
  titleAuthorize: 'Permitir acceso',
};

const ZH: SignInTexts = {
  heading: '将 {client} 连接到 {server}',
  subSignedIn: '{client} 将使用你的角色在 {server} 上允许的工具。你始终掌控一切，可随时断开连接。',
  subSignedOut: '登录后，{client} 即可使用你的 {server} 工具。你始终掌控一切，可随时断开连接。',
  value: '之后 {client} 就能使用你常用的应用，例如 Telegram、Etsy、WooCommerce 或 Odoo。免费开始，无需银行卡。',
  canDo: '{client} 将能够',
  tools: '使用你的 MCP 服务器上你的角色允许的工具',
  toolsOn: '使用 {server} 上你的角色允许的工具',
  readProfile: '读取你的姓名和电子邮件地址',
  noSecrets: '它永远看不到你的连接器密码或 API 密钥',
  scope: '请求的范围：',
  sentIfAllow: '如果你允许，访问权限将发送到 {host}',
  sentAfterSignIn: '登录后，访问权限将发送到 {host}',
  warn: '仅在你本人发起此请求并认识该目标时才继续。否则请选择<strong>{cancel}</strong>。',
  cancel: '取消',
  signInAllow: '登录并允许',
  allow: '允许访问',
  signedInAs: '已登录为 {email}',
  switchAccount: '切换账户',
  continueWith: '使用 {provider} 继续',
  terms: '新用户？继续即表示创建账户并接受{terms}和{privacy}。',
  termsLabel: '条款',
  privacyLabel: '隐私政策',
  orEmail: '或使用电子邮件',
  email: '电子邮件',
  password: '密码',
  passwordPlaceholder: '你的密码',
  forgot: '忘记密码？',
  noAccount: '还没有账户？上面的按钮会为你创建一个。',
  createWithEmail: '用电子邮件创建账户',
  titleSignIn: '登录',
  titleAuthorize: '允许访问',
};

const JA: SignInTexts = {
  heading: '{client} を {server} に接続',
  subSignedIn: '{client} は {server} 上で、あなたのロールが許可するツールを使用します。管理はあなたのままで、いつでも接続を解除できます。',
  subSignedOut: 'ログインすると、{client} があなたの {server} のツールを使えるようになります。管理はあなたのままで、いつでも接続を解除できます。',
  value: 'その後、{client} は Telegram、Etsy、WooCommerce、Odoo など、お使いのアプリと連携できます。無料で開始でき、カードは不要です。',
  canDo: '{client} ができること',
  tools: 'あなたのロールが許可する MCP サーバーのツールを使用する',
  toolsOn: 'あなたのロールが許可する {server} のツールを使用する',
  readProfile: 'あなたの名前とメールアドレスを読み取る',
  noSecrets: 'コネクタのパスワードや API キーを見ることはありません',
  scope: '要求された範囲：',
  sentIfAllow: '許可すると、アクセス権は {host} に送られます',
  sentAfterSignIn: 'ログイン後、アクセス権は {host} に送られます',
  warn: 'ご自身で開始し、この送信先に心当たりがある場合のみ続行してください。そうでない場合は<strong>{cancel}</strong>を選んでください。',
  cancel: 'キャンセル',
  signInAllow: 'ログインして許可',
  allow: 'アクセスを許可',
  signedInAs: '{email} でログイン中',
  switchAccount: 'アカウントを切り替える',
  continueWith: '{provider} で続行',
  terms: '初めての方へ：続行するとアカウントが作成され、{terms}と{privacy}に同意したことになります。',
  termsLabel: '利用規約',
  privacyLabel: 'プライバシーポリシー',
  orEmail: 'またはメールアドレスで',
  email: 'メールアドレス',
  password: 'パスワード',
  passwordPlaceholder: 'パスワード',
  forgot: 'パスワードをお忘れですか？',
  noAccount: 'アカウントをお持ちでない方は、上のボタンで作成できます。',
  createWithEmail: 'メールアドレスでアカウントを作成',
  titleSignIn: 'ログイン',
  titleAuthorize: 'アクセスを許可',
};

const RU: SignInTexts = {
  heading: 'Подключите {client} к {server}',
  subSignedIn: '{client} будет использовать инструменты {server}, разрешённые вашей ролью. Вы сохраняете контроль и можете отключить его в любой момент.',
  subSignedOut: 'Войдите, чтобы {client} мог использовать ваши инструменты {server}. Вы сохраняете контроль и можете отключить его в любой момент.',
  value: 'После этого {client} работает с вашими приложениями, например Telegram, Etsy, WooCommerce или Odoo. Начните бесплатно, без карты.',
  canDo: '{client} сможет',
  tools: 'использовать инструменты вашего MCP-сервера, разрешённые вашей ролью',
  toolsOn: 'использовать инструменты {server}, разрешённые вашей ролью',
  readProfile: 'читать ваше имя и адрес электронной почты',
  noSecrets: 'Он никогда не видит пароли и API-ключи ваших коннекторов',
  scope: 'Запрошенный доступ:',
  sentIfAllow: 'Если вы разрешите, доступ будет передан {host}',
  sentAfterSignIn: 'После входа доступ будет передан {host}',
  warn: 'Продолжайте, только если вы сами начали это и узнаёте этот адрес. Если нет, нажмите <strong>{cancel}</strong>.',
  cancel: 'Отмена',
  signInAllow: 'Войти и разрешить',
  allow: 'Разрешить доступ',
  signedInAs: 'Вы вошли как {email}',
  switchAccount: 'Сменить аккаунт',
  continueWith: 'Продолжить с {provider}',
  terms: 'Впервые здесь? Продолжая, вы создаёте аккаунт и принимаете {terms} и {privacy}.',
  termsLabel: 'Условия',
  privacyLabel: 'Политику конфиденциальности',
  orEmail: 'или по электронной почте',
  email: 'Электронная почта',
  password: 'Пароль',
  passwordPlaceholder: 'Ваш пароль',
  forgot: 'Забыли пароль?',
  noAccount: 'Ещё нет аккаунта? Кнопки выше создадут его.',
  createWithEmail: 'Создать аккаунт по электронной почте',
  titleSignIn: 'Вход',
  titleAuthorize: 'Разрешить доступ',
};

export const SIGN_IN_TEXTS: Record<PageLanguage, SignInTexts> = {
  en: EN,
  de: DE,
  it: IT,
  es: ES,
  zh: ZH,
  ja: JA,
  ru: RU,
};

/** The texts for a language, English when the browser speaks none of ours. */
export function signInTexts(lang: PageLanguage | null | undefined): SignInTexts {
  return (lang && SIGN_IN_TEXTS[lang]) || EN;
}

/**
 * Replaces `{name}` placeholders. Values must already be HTML-escaped; a
 * placeholder without a value is left as it is, so a missing one shows up in
 * tests instead of silently disappearing.
 */
export function fill(text: string, values: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? values[key] : match));
}

/** The dictionary of one page group for a language, English when the language is not ours. */
export function textsFor<T>(table: Record<PageLanguage, T>): (lang: PageLanguage | null | undefined) => T {
  return (lang) => (lang && table[lang]) || table.en;
}

/** The locale used for dates and plural rules of a page language. */
export const PAGE_LOCALES: Record<PageLanguage, string> = {
  en: 'en-US',
  de: 'de-DE',
  it: 'it-IT',
  es: 'es-ES',
  zh: 'zh-CN',
  ja: 'ja-JP',
  ru: 'ru-RU',
};

/** The four plural forms a dictionary carries (Russian needs all of them). */
export interface PluralTexts {
  one: string;
  few: string;
  many: string;
  other: string;
}

/** The plural form of `n` in a page language, with `{n}` filled in. */
export function plural(forms: PluralTexts, lang: PageLanguage, n: number): string {
  const category = new Intl.PluralRules(PAGE_LOCALES[lang]).select(n);
  const form = category === 'one' || category === 'few' || category === 'many' ? forms[category] : forms.other;
  return fill(form, { n: String(n) });
}

/**
 * Texts for an inline `<script>`, as a JavaScript object literal: JSON, with
 * the characters that could end the script element or a line of it written
 * as escapes (`<`, `>`, `&`, U+2028, U+2029). This is the only way a
 * dictionary text gets into script source; a script never has one
 * concatenated into it. The texts are plain: the scripts put them into
 * `textContent`, with their placeholders filled by SCRIPT_FILL.
 */
export function scriptTexts(texts: Record<string, string>): string {
  return JSON.stringify(texts).replace(
    /[<>&\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/**
 * `fill` for the page scripts (written for old browsers, like the scripts).
 * Values are whatever the page holds (the client's name from `data-client`,
 * an app's name): the result only ever goes into `textContent`.
 */
export const SCRIPT_FILL = `var fill = function (text, values) {
        return String(text).replace(/\\{(\\w+)\\}/g, function (match, key) {
          return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match;
        });
      };`;
