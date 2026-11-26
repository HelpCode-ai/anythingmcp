import type { PageLanguage } from './authorization-attempt';
import { fill, textsFor, type PluralTexts } from './auth-page-i18n';

/**
 * The steps between the sign-in page and "allowed" in the seven languages of
 * the trial pages: the e-mail code step, "Choose what to connect", and the
 * messages the sign-in page shows after a redirect.
 *
 * Same rules as in auth-page-i18n.ts: placeholders in braces are replaced by
 * `fill`, every value put into a text that is used as HTML must already be
 * HTML-escaped by the caller, and a text contains only the markup written
 * here (<strong>).
 */

/** The e-mail code step (Cloud): `renderEmailCodePage` and the notices of its routes. */
export interface EmailCodeTexts {
  title: string;
  heading: string;
  subConnect: string; // {email} {client}
  subSignIn: string; // {email}
  /** In place of the masked address, when it cannot be shown. */
  yourAddress: string;
  codeLabel: string;
  verify: string;
  resend: string;
  openedLink: string;
  or: string;
  providerAccount: string; // {providers}
  /** Between the provider names of `providerAccount`, and before the last one. */
  providerSep: string;
  providerLast: string;
  noEmail: string;
  otherAccount: string;
  // Notices and errors of the step's routes (plain text, escaped when shown).
  codeWrong: string;
  notVerifiedYet: string;
  resendTooSoon: string;
  tooManyCodes: string;
  newCodeSent: string;
}

/** The keys of EmailCodeTexts a route of the code step may show as a notice or an error. */
export type EmailCodeMessage = 'codeWrong' | 'notVerifiedYet' | 'resendTooSoon' | 'tooManyCodes' | 'newCodeSent';

const EMAIL_CODE_EN: EmailCodeTexts = {
  title: 'Verify your email',
  heading: 'Check your email',
  subConnect: 'We sent a 6-digit code to <strong>{email}</strong>. Enter it to finish connecting <strong>{client}</strong>.',
  subSignIn: 'We sent a 6-digit code to <strong>{email}</strong>. Enter it to finish signing in.',
  yourAddress: 'your address',
  codeLabel: 'Verification code',
  verify: 'Verify and continue',
  resend: 'Send a new code',
  openedLink: 'I opened the link in the email',
  or: 'or',
  providerAccount:
    'If this address is a {providers} account, continuing with it verifies the address without a code. You then sign in that way instead of with your password.',
  providerSep: ' or ',
  providerLast: ' or ',
  noEmail: 'No email? Check the spam folder.',
  otherAccount: 'Use a different account',
  codeWrong: 'That code is wrong or has expired. Use the newest email, or send a new code.',
  notVerifiedYet: 'Your address is not verified yet. Enter the code from the email, or open its link first.',
  resendTooSoon: 'A code was sent less than a minute ago. Check your inbox and spam folder, or ask again in a minute.',
  tooManyCodes: 'You asked for many codes in the last hour: use the newest email you received, or try again later.',
  newCodeSent: 'A new code is on its way. Codes sent before it no longer work.',
};

const EMAIL_CODE_DE: EmailCodeTexts = {
  title: 'E-Mail-Adresse bestätigen',
  heading: 'Prüfen Sie Ihre E-Mails',
  subConnect:
    'Wir haben einen 6-stelligen Code an <strong>{email}</strong> gesendet. Geben Sie ihn ein, um die Verbindung mit <strong>{client}</strong> abzuschließen.',
  subSignIn:
    'Wir haben einen 6-stelligen Code an <strong>{email}</strong> gesendet. Geben Sie ihn ein, um die Anmeldung abzuschließen.',
  yourAddress: 'Ihre Adresse',
  codeLabel: 'Bestätigungscode',
  verify: 'Bestätigen und weiter',
  resend: 'Neuen Code senden',
  openedLink: 'Ich habe den Link in der E-Mail geöffnet',
  or: 'oder',
  providerAccount:
    'Gehört diese Adresse zu einem Konto bei {providers}, bestätigt die Anmeldung damit die Adresse ohne Code. Sie melden sich danach auf diesem Weg an statt mit Ihrem Passwort.',
  providerSep: ', ',
  providerLast: ' oder ',
  noEmail: 'Keine E-Mail erhalten? Sehen Sie im Spam-Ordner nach.',
  otherAccount: 'Anderes Konto verwenden',
  codeWrong: 'Dieser Code ist falsch oder abgelaufen. Verwenden Sie die neueste E-Mail oder senden Sie einen neuen Code.',
  notVerifiedYet:
    'Ihre Adresse ist noch nicht bestätigt. Geben Sie den Code aus der E-Mail ein oder öffnen Sie zuerst den Link darin.',
  resendTooSoon:
    'Vor weniger als einer Minute wurde ein Code gesendet. Sehen Sie in Posteingang und Spam-Ordner nach oder versuchen Sie es in einer Minute erneut.',
  tooManyCodes:
    'Sie haben in der letzten Stunde viele Codes angefordert: Verwenden Sie die neueste E-Mail, die Sie erhalten haben, oder versuchen Sie es später erneut.',
  newCodeSent: 'Ein neuer Code ist unterwegs. Zuvor gesendete Codes funktionieren nicht mehr.',
};

const EMAIL_CODE_IT: EmailCodeTexts = {
  title: 'Verifica la tua email',
  heading: 'Controlla la tua email',
  subConnect:
    'Abbiamo inviato un codice di 6 cifre all’indirizzo <strong>{email}</strong>. Inseriscilo per completare il collegamento di <strong>{client}</strong>.',
  subSignIn:
    'Abbiamo inviato un codice di 6 cifre all’indirizzo <strong>{email}</strong>. Inseriscilo per completare l’accesso.',
  // Follows "all’indirizzo".
  yourAddress: 'del tuo account',
  codeLabel: 'Codice di verifica',
  verify: 'Verifica e continua',
  resend: 'Invia un nuovo codice',
  openedLink: 'Ho aperto il link nell’email',
  or: 'oppure',
  providerAccount:
    'Se questo indirizzo è un account {providers}, continuando con quello verifichi l’indirizzo senza codice. Poi accedi in quel modo invece che con la password.',
  providerSep: ', ',
  providerLast: ' o ',
  noEmail: 'Nessuna email? Controlla la cartella spam.',
  otherAccount: 'Usa un altro account',
  codeWrong: 'Il codice è errato o scaduto. Usa l’email più recente oppure invia un nuovo codice.',
  notVerifiedYet:
    'Il tuo indirizzo non è ancora verificato. Inserisci il codice ricevuto via email oppure apri prima il link che contiene.',
  resendTooSoon:
    'Un codice è stato inviato meno di un minuto fa. Controlla la posta in arrivo e la cartella spam, oppure riprova tra un minuto.',
  tooManyCodes:
    'Hai richiesto molti codici nell’ultima ora: usa l’email più recente che hai ricevuto, oppure riprova più tardi.',
  newCodeSent: 'Un nuovo codice è in arrivo. I codici inviati prima non funzionano più.',
};

const EMAIL_CODE_ES: EmailCodeTexts = {
  title: 'Verifica tu correo',
  heading: 'Revisa tu correo',
  subConnect:
    'Hemos enviado un código de 6 dígitos a <strong>{email}</strong>. Introdúcelo para terminar de conectar <strong>{client}</strong>.',
  subSignIn:
    'Hemos enviado un código de 6 dígitos a <strong>{email}</strong>. Introdúcelo para terminar de iniciar sesión.',
  yourAddress: 'tu dirección',
  codeLabel: 'Código de verificación',
  verify: 'Verificar y continuar',
  resend: 'Enviar un código nuevo',
  openedLink: 'He abierto el enlace del correo',
  or: 'o',
  providerAccount:
    'Si esta dirección es una cuenta de {providers}, al continuar con ella se verifica la dirección sin código. Después inicias sesión así, en lugar de con tu contraseña.',
  providerSep: ', ',
  providerLast: ' o ',
  noEmail: '¿No te ha llegado el correo? Revisa la carpeta de spam.',
  otherAccount: 'Usar otra cuenta',
  codeWrong: 'El código es incorrecto o ha caducado. Usa el correo más reciente o envía un código nuevo.',
  notVerifiedYet: 'Tu dirección aún no está verificada. Introduce el código del correo o abre antes su enlace.',
  resendTooSoon:
    'Se envió un código hace menos de un minuto. Revisa tu bandeja de entrada y la carpeta de spam, o vuelve a pedirlo dentro de un minuto.',
  tooManyCodes:
    'Has pedido muchos códigos en la última hora: usa el correo más reciente que hayas recibido o inténtalo más tarde.',
  newCodeSent: 'Hay un código nuevo en camino. Los códigos enviados antes ya no funcionan.',
};

const EMAIL_CODE_ZH: EmailCodeTexts = {
  title: '验证你的电子邮件',
  heading: '请查看你的邮箱',
  subConnect: '我们已向 <strong>{email}</strong> 发送了 6 位验证码。输入验证码即可完成 <strong>{client}</strong> 的连接。',
  subSignIn: '我们已向 <strong>{email}</strong> 发送了 6 位验证码。输入验证码即可完成登录。',
  yourAddress: '你的邮箱',
  codeLabel: '验证码',
  verify: '验证并继续',
  resend: '发送新的验证码',
  openedLink: '我已打开邮件中的链接',
  or: '或',
  providerAccount:
    '如果此地址是 {providers} 账户，使用它继续即可验证该地址，无需验证码。之后你将通过这种方式登录，而不是使用密码。',
  providerSep: '、',
  providerLast: ' 或 ',
  noEmail: '没有收到邮件？请查看垃圾邮件文件夹。',
  otherAccount: '使用其他账户',
  codeWrong: '验证码错误或已过期。请使用最新的邮件，或发送新的验证码。',
  notVerifiedYet: '你的地址尚未验证。请输入邮件中的验证码，或先打开邮件中的链接。',
  resendTooSoon: '不到一分钟前已发送过验证码。请查看收件箱和垃圾邮件文件夹，或一分钟后再试。',
  tooManyCodes: '你在过去一小时内请求了多次验证码：请使用你收到的最新邮件，或稍后再试。',
  newCodeSent: '新的验证码已发出。之前发送的验证码不再有效。',
};

const EMAIL_CODE_JA: EmailCodeTexts = {
  title: 'メールアドレスの確認',
  heading: 'メールをご確認ください',
  subConnect:
    '<strong>{email}</strong> に 6 桁のコードを送信しました。入力すると <strong>{client}</strong> の接続が完了します。',
  subSignIn: '<strong>{email}</strong> に 6 桁のコードを送信しました。入力するとログインが完了します。',
  yourAddress: 'ご登録のメールアドレス',
  codeLabel: '確認コード',
  verify: '確認して続行',
  resend: '新しいコードを送信',
  openedLink: 'メール内のリンクを開きました',
  or: 'または',
  providerAccount:
    'このアドレスが {providers} のアカウントであれば、そのアカウントで続行するとコードなしでアドレスを確認できます。以後はパスワードではなく、その方法でログインします。',
  providerSep: '、',
  providerLast: ' または ',
  noEmail: 'メールが届きませんか？迷惑メールフォルダをご確認ください。',
  otherAccount: '別のアカウントを使用',
  codeWrong:
    'コードが正しくないか、有効期限が切れています。最新のメールのコードを使うか、新しいコードを送信してください。',
  notVerifiedYet:
    'アドレスはまだ確認されていません。メールのコードを入力するか、先にメール内のリンクを開いてください。',
  resendTooSoon:
    'コードは 1 分以内に送信済みです。受信トレイと迷惑メールフォルダを確認するか、1 分後にもう一度お試しください。',
  tooManyCodes:
    '過去 1 時間に多くのコードをリクエストされました。最後に届いたメールのコードを使うか、しばらくしてからもう一度お試しください。',
  newCodeSent: '新しいコードを送信しました。それ以前のコードは使えなくなります。',
};

const EMAIL_CODE_RU: EmailCodeTexts = {
  title: 'Подтвердите адрес почты',
  heading: 'Проверьте почту',
  subConnect:
    'Мы отправили 6-значный код на <strong>{email}</strong>. Введите его, чтобы завершить подключение <strong>{client}</strong>.',
  subSignIn: 'Мы отправили 6-значный код на <strong>{email}</strong>. Введите его, чтобы завершить вход.',
  yourAddress: 'ваш адрес',
  codeLabel: 'Код подтверждения',
  verify: 'Подтвердить и продолжить',
  resend: 'Отправить новый код',
  openedLink: 'Ссылка из письма открыта',
  or: 'или',
  providerAccount:
    'Если этот адрес — аккаунт {providers}, вход через него подтвердит адрес без кода. После этого вы будете входить этим способом, а не с паролем.',
  providerSep: ', ',
  providerLast: ' или ',
  noEmail: 'Нет письма? Проверьте папку «Спам».',
  otherAccount: 'Войти с другим аккаунтом',
  codeWrong: 'Код неверный или его срок истёк. Используйте самое новое письмо или отправьте новый код.',
  notVerifiedYet: 'Ваш адрес ещё не подтверждён. Введите код из письма или сначала откройте ссылку из него.',
  resendTooSoon:
    'Код был отправлен меньше минуты назад. Проверьте входящие и папку «Спам» или повторите запрос через минуту.',
  tooManyCodes:
    'За последний час вы запросили много кодов: используйте самое новое письмо или повторите попытку позже.',
  newCodeSent: 'Новый код уже в пути. Отправленные ранее коды больше не действуют.',
};

export const EMAIL_CODE_TEXTS: Record<PageLanguage, EmailCodeTexts> = {
  en: EMAIL_CODE_EN,
  de: EMAIL_CODE_DE,
  it: EMAIL_CODE_IT,
  es: EMAIL_CODE_ES,
  zh: EMAIL_CODE_ZH,
  ja: EMAIL_CODE_JA,
  ru: EMAIL_CODE_RU,
};
export const emailCodeTexts = textsFor(EMAIL_CODE_TEXTS);

/** "Choose what to connect" (`renderServerPicker`). */
export interface ServerPickerTexts {
  heading: string;
  sub: string; // {client}
  /** "3 connectors" beside a server: {n}. */
  connectors: PluralTexts;
  everything: string;
  everythingSub: string;
  /** The whole-workspace option where member visibility narrows the user's view. */
  roleTools: string;
  roleToolsSub: string;
  pickError: string;
  connect: string;
  note: string;
}

const SERVER_PICKER_EN: ServerPickerTexts = {
  heading: 'Choose what to connect',
  sub: '<strong>{client}</strong> will be able to use the tools from whatever you pick here, as far as your role allows, and nothing else.',
  connectors: { one: '{n} connector', few: '{n} connectors', many: '{n} connectors', other: '{n} connectors' },
  everything: 'Everything in this workspace',
  everythingSub: 'including connectors not on a server',
  roleTools: 'The tools your role allows',
  roleToolsSub: 'in this workspace, from every connector shared with you',
  pickError: 'Choose at least one server, or a whole workspace.',
  connect: 'Connect',
  note: 'You can change this later from Settings, without reconnecting.',
};

const SERVER_PICKER_DE: ServerPickerTexts = {
  heading: 'Was möchten Sie verbinden?',
  sub: '<strong>{client}</strong> kann die Tools aus dem nutzen, was Sie hier auswählen, soweit Ihre Rolle es erlaubt, und sonst nichts.',
  connectors: { one: '{n} Connector', few: '{n} Connectors', many: '{n} Connectors', other: '{n} Connectors' },
  everything: 'Alles in diesem Workspace',
  everythingSub: 'auch Connectors, die auf keinem Server liegen',
  roleTools: 'Die Tools, die Ihre Rolle erlaubt',
  roleToolsSub: 'in diesem Workspace, aus allen für Sie freigegebenen Connectors',
  pickError: 'Wählen Sie mindestens einen Server oder einen ganzen Workspace.',
  connect: 'Verbinden',
  note: 'Sie können das später in den Einstellungen ändern, ohne neu zu verbinden.',
};

const SERVER_PICKER_IT: ServerPickerTexts = {
  heading: 'Scegli cosa collegare',
  sub: '<strong>{client}</strong> potrà usare gli strumenti di ciò che scegli qui, nei limiti del tuo ruolo, e nient’altro.',
  connectors: { one: '{n} connettore', few: '{n} connettori', many: '{n} connettori', other: '{n} connettori' },
  everything: 'Tutto in questo workspace',
  everythingSub: 'compresi i connettori non assegnati a un server',
  roleTools: 'Gli strumenti consentiti dal tuo ruolo',
  roleToolsSub: 'in questo workspace, da tutti i connettori condivisi con te',
  pickError: 'Scegli almeno un server oppure un intero workspace.',
  connect: 'Collega',
  note: 'Puoi cambiarlo più tardi dalle Impostazioni, senza ricollegare.',
};

const SERVER_PICKER_ES: ServerPickerTexts = {
  heading: 'Elige qué conectar',
  sub: '<strong>{client}</strong> podrá usar las herramientas de lo que elijas aquí, hasta donde tu rol lo permita, y nada más.',
  connectors: { one: '{n} conector', few: '{n} conectores', many: '{n} conectores', other: '{n} conectores' },
  everything: 'Todo lo de este workspace',
  everythingSub: 'incluidos los conectores que no están en ningún servidor',
  roleTools: 'Las herramientas que permite tu rol',
  roleToolsSub: 'en este workspace, de todos los conectores compartidos contigo',
  pickError: 'Elige al menos un servidor o un workspace entero.',
  connect: 'Conectar',
  note: 'Puedes cambiarlo más adelante en Ajustes, sin volver a conectar.',
};

const SERVER_PICKER_ZH: ServerPickerTexts = {
  heading: '选择要连接的内容',
  sub: '<strong>{client}</strong> 只能在你的角色允许的范围内，使用你在这里所选内容中的工具，仅此而已。',
  connectors: { one: '{n} 个连接器', few: '{n} 个连接器', many: '{n} 个连接器', other: '{n} 个连接器' },
  everything: '此工作区中的全部内容',
  everythingSub: '包括未关联到任何服务器的连接器',
  roleTools: '你的角色允许的工具',
  roleToolsSub: '此工作区中与你共享的所有连接器',
  pickError: '请至少选择一个服务器，或选择整个工作区。',
  connect: '连接',
  note: '之后可以在设置中更改，无需重新连接。',
};

const SERVER_PICKER_JA: ServerPickerTexts = {
  heading: '接続する対象を選択',
  sub: '<strong>{client}</strong> は、ここで選んだ対象のツールを、あなたのロールが許可する範囲で使用できます。それ以外にはアクセスできません。',
  connectors: { one: 'コネクタ {n} 件', few: 'コネクタ {n} 件', many: 'コネクタ {n} 件', other: 'コネクタ {n} 件' },
  everything: 'このワークスペースのすべて',
  everythingSub: 'サーバーに割り当てられていないコネクタを含む',
  roleTools: 'あなたのロールで許可されたツール',
  roleToolsSub: 'このワークスペースで共有されているすべてのコネクタから',
  pickError: 'サーバーを 1 つ以上、またはワークスペース全体を選択してください。',
  connect: '接続',
  note: 'この選択は、再接続せずに後から「設定」で変更できます。',
};

const SERVER_PICKER_RU: ServerPickerTexts = {
  heading: 'Выберите, что подключить',
  sub: '<strong>{client}</strong> сможет использовать инструменты того, что вы выберете здесь, в пределах вашей роли, и ничего больше.',
  connectors: { one: '{n} коннектор', few: '{n} коннектора', many: '{n} коннекторов', other: '{n} коннектора' },
  everything: 'Всё в этом workspace',
  everythingSub: 'включая коннекторы, не привязанные к серверу',
  roleTools: 'Инструменты, разрешённые вашей ролью',
  roleToolsSub: 'в этом workspace, из всех коннекторов, к которым вам дали доступ',
  pickError: 'Выберите хотя бы один сервер или весь workspace.',
  connect: 'Подключить',
  note: 'Это можно изменить позже в настройках, без повторного подключения.',
};

export const SERVER_PICKER_TEXTS: Record<PageLanguage, ServerPickerTexts> = {
  en: SERVER_PICKER_EN,
  de: SERVER_PICKER_DE,
  it: SERVER_PICKER_IT,
  es: SERVER_PICKER_ES,
  zh: SERVER_PICKER_ZH,
  ja: SERVER_PICKER_JA,
  ru: SERVER_PICKER_RU,
};
export const serverPickerTexts = textsFor(SERVER_PICKER_TEXTS);

/**
 * The messages the sign-in page (or, without an open authorization, the
 * "no longer open" page) shows after a redirect to `/auth/login?error=…`.
 *
 * They used to travel through that redirect as English text. Now the
 * redirect carries the KEY of the message (`error=sessionExpired`, or
 * `error=providerNoEmail:google` for the three that name a provider) and the
 * page shows it in its own language: see `loginErrorParam` and
 * `loginErrorText`. All plain text, escaped when shown.
 */
export interface LoginErrorTexts {
  sessionExpired: string;
  sessionEnded: string;
  sessionExpiredSignIn: string;
  signInAgain: string;
  ssoUnavailable: string;
  credentialsRequired: string;
  invalidCredentials: string;
  /** With provider buttons on the page: {providers}. */
  signInFailed: string;
  passwordDisabled: string;
  verifyEmailFirst: string;
  optionUnavailable: string;
  optionUnavailableNow: string;
  wrongWorkspace: string;
  noServersAvailable: string;
  chooseServer: string;
  // What a sign-in with Google, Microsoft or GitHub can end in (social-auth.service.ts).
  socialFailed: string;
  authorizationExpired: string;
  linkExpired: string;
  otherBrowser: string;
  cancelled: string;
  providerFailed: string;
  ssoRequired: string;
  noWorkspace: string;
  providerNoEmail: string; // {provider}
  providerUnverified: string; // {provider}
  ambiguousEmail: string;
  alreadyLinked: string; // {provider}
  registrationClosed: string;
  disposableEmail: string;
  /** "Google, Microsoft or GitHub": between the names, and before the last one. */
  listSep: string;
  listOr: string;
}

const LOGIN_ERRORS_EN: LoginErrorTexts = {
  sessionExpired: 'Your session expired. Please try again.',
  sessionEnded: 'Your session has expired. Please sign in.',
  sessionExpiredSignIn: 'Your session expired. Please sign in again.',
  signInAgain: 'Please sign in again.',
  ssoUnavailable: 'Single sign-on is unavailable. Please contact your administrator.',
  credentialsRequired: 'Email and password are required',
  invalidCredentials: 'Invalid email or password',
  signInFailed:
    'That email and password do not match. If you signed up with {providers}, use that button instead. New here? Create an account first.',
  passwordDisabled: 'Password sign-in is disabled for this account. Use your organization sign-in.',
  verifyEmailFirst: 'Verify your email address first: open the link in the email we sent you.',
  optionUnavailable: 'This sign-in option is not available.',
  optionUnavailableNow: 'This sign-in option is not available right now.',
  wrongWorkspace:
    'The MCP server you are connecting belongs to another workspace, and this account is not a member of it. ' +
    'Sign in with an account of that workspace, or ask its admin to invite you. ' +
    'If you do not need this connection, remove it from your AI client.',
  noServersAvailable: 'None of the selected servers are available to you. Please try again.',
  chooseServer: 'Choose at least one MCP server.',
  socialFailed: 'Sign-in failed. Please try again.',
  authorizationExpired: 'Your authorization request expired. Start again from your AI client.',
  linkExpired: 'This sign-in link has expired. Please try again.',
  otherBrowser: 'Sign-in could not be completed in this browser. Please try again.',
  cancelled: 'Sign-in was cancelled.',
  providerFailed: 'The provider could not sign you in. Please try again.',
  ssoRequired: 'Your organization requires its own single sign-on for this account.',
  noWorkspace: 'This account has no active workspace.',
  providerNoEmail:
    'Your {provider} account did not share a verified email address. Sign up with your email address instead.',
  providerUnverified:
    '{provider} could not confirm your email address. Sign up with your email address, then connect {provider} in Settings.',
  ambiguousEmail: 'Please sign in with your email and password, then connect this account in Settings.',
  alreadyLinked: 'Your account is already connected to a different {provider} account.',
  registrationClosed: 'New sign-ups are closed on this instance.',
  disposableEmail: 'Please use a permanent email address.',
  listSep: ', ',
  listOr: ' or ',
};

const LOGIN_ERRORS_DE: LoginErrorTexts = {
  sessionExpired: 'Ihre Sitzung ist abgelaufen. Bitte versuchen Sie es erneut.',
  sessionEnded: 'Ihre Sitzung ist abgelaufen. Bitte melden Sie sich an.',
  sessionExpiredSignIn: 'Ihre Sitzung ist abgelaufen. Bitte melden Sie sich erneut an.',
  signInAgain: 'Bitte melden Sie sich erneut an.',
  ssoUnavailable: 'Single Sign-On ist nicht verfügbar. Bitte wenden Sie sich an Ihren Administrator.',
  credentialsRequired: 'E-Mail und Passwort sind erforderlich',
  invalidCredentials: 'E-Mail oder Passwort ungültig',
  signInFailed:
    'Diese E-Mail-Adresse und dieses Passwort passen nicht zusammen. Wenn Sie sich mit {providers} registriert haben, verwenden Sie stattdessen diese Schaltfläche. Neu hier? Erstellen Sie zuerst ein Konto.',
  passwordDisabled:
    'Die Anmeldung mit Passwort ist für dieses Konto deaktiviert. Verwenden Sie die Anmeldung Ihrer Organisation.',
  verifyEmailFirst:
    'Bestätigen Sie zuerst Ihre E-Mail-Adresse: Öffnen Sie den Link in der E-Mail, die wir Ihnen gesendet haben.',
  optionUnavailable: 'Diese Anmeldeoption ist nicht verfügbar.',
  optionUnavailableNow: 'Diese Anmeldeoption ist gerade nicht verfügbar.',
  wrongWorkspace:
    'Der MCP-Server, den Sie verbinden, gehört zu einem anderen Workspace, und dieses Konto ist dort kein Mitglied. ' +
    'Melden Sie sich mit einem Konto dieses Workspace an oder bitten Sie dessen Admin, Sie einzuladen. ' +
    'Wenn Sie diese Verbindung nicht brauchen, entfernen Sie sie in Ihrem KI-Assistenten.',
  noServersAvailable: 'Keiner der ausgewählten Server ist für Sie verfügbar. Bitte versuchen Sie es erneut.',
  chooseServer: 'Wählen Sie mindestens einen MCP-Server.',
  socialFailed: 'Die Anmeldung ist fehlgeschlagen. Bitte versuchen Sie es erneut.',
  authorizationExpired:
    'Ihre Autorisierungsanfrage ist abgelaufen. Beginnen Sie in Ihrem KI-Assistenten noch einmal von vorn.',
  linkExpired: 'Dieser Anmeldelink ist abgelaufen. Bitte versuchen Sie es erneut.',
  otherBrowser:
    'Die Anmeldung konnte in diesem Browser nicht abgeschlossen werden. Bitte versuchen Sie es erneut.',
  cancelled: 'Die Anmeldung wurde abgebrochen.',
  providerFailed: 'Der Anbieter konnte Sie nicht anmelden. Bitte versuchen Sie es erneut.',
  ssoRequired: 'Ihre Organisation verlangt für dieses Konto ihr eigenes Single Sign-On.',
  noWorkspace: 'Dieses Konto hat keinen aktiven Workspace.',
  providerNoEmail:
    'Ihr {provider}-Konto hat keine bestätigte E-Mail-Adresse übermittelt. Registrieren Sie sich stattdessen mit Ihrer E-Mail-Adresse.',
  providerUnverified:
    '{provider} konnte Ihre E-Mail-Adresse nicht bestätigen. Registrieren Sie sich mit Ihrer E-Mail-Adresse und verbinden Sie {provider} danach in den Einstellungen.',
  ambiguousEmail:
    'Bitte melden Sie sich mit E-Mail und Passwort an und verbinden Sie dieses Konto danach in den Einstellungen.',
  alreadyLinked: 'Ihr Konto ist bereits mit einem anderen {provider}-Konto verbunden.',
  registrationClosed: 'Neue Registrierungen sind auf dieser Instanz geschlossen.',
  disposableEmail: 'Bitte verwenden Sie eine dauerhafte E-Mail-Adresse.',
  listSep: ', ',
  listOr: ' oder ',
};

const LOGIN_ERRORS_IT: LoginErrorTexts = {
  sessionExpired: 'La sessione è scaduta. Riprova.',
  sessionEnded: 'La sessione è scaduta. Effettua l’accesso.',
  sessionExpiredSignIn: 'La sessione è scaduta. Accedi di nuovo.',
  signInAgain: 'Accedi di nuovo.',
  ssoUnavailable: 'Il single sign-on non è disponibile. Contatta il tuo amministratore.',
  credentialsRequired: 'Email e password sono obbligatorie',
  invalidCredentials: 'Email o password non valide',
  signInFailed:
    'Email e password non corrispondono. Se ti sei registrato con {providers}, usa quel pulsante. Sei nuovo? Crea prima un account.',
  passwordDisabled:
    'L’accesso con password è disattivato per questo account. Usa l’accesso della tua organizzazione.',
  verifyEmailFirst: 'Verifica prima il tuo indirizzo email: apri il link nell’email che ti abbiamo inviato.',
  optionUnavailable: 'Questa opzione di accesso non è disponibile.',
  optionUnavailableNow: 'Questa opzione di accesso non è disponibile in questo momento.',
  wrongWorkspace:
    'Il server MCP che stai collegando appartiene a un altro workspace e questo account non ne fa parte. ' +
    'Accedi con un account di quel workspace oppure chiedi al suo admin di invitarti. ' +
    'Se questa connessione non ti serve, rimuovila dal tuo assistente AI.',
  noServersAvailable: 'Nessuno dei server selezionati è disponibile per te. Riprova.',
  chooseServer: 'Scegli almeno un server MCP.',
  socialFailed: 'Accesso non riuscito. Riprova.',
  authorizationExpired: 'La richiesta di autorizzazione è scaduta. Ricomincia dal tuo assistente AI.',
  linkExpired: 'Questo link di accesso è scaduto. Riprova.',
  otherBrowser: 'Non è stato possibile completare l’accesso in questo browser. Riprova.',
  cancelled: 'Accesso annullato.',
  providerFailed: 'Il provider non è riuscito a farti accedere. Riprova.',
  ssoRequired: 'La tua organizzazione richiede il proprio single sign-on per questo account.',
  noWorkspace: 'Questo account non ha un workspace attivo.',
  providerNoEmail:
    'Il tuo account {provider} non ha condiviso un indirizzo email verificato. Registrati invece con il tuo indirizzo email.',
  providerUnverified:
    '{provider} non ha potuto confermare il tuo indirizzo email. Registrati con il tuo indirizzo email, poi collega {provider} nelle Impostazioni.',
  ambiguousEmail: 'Accedi con email e password, poi collega questo account nelle Impostazioni.',
  alreadyLinked: 'Il tuo account è già collegato a un altro account {provider}.',
  registrationClosed: 'Le nuove registrazioni sono chiuse su questa istanza.',
  disposableEmail: 'Usa un indirizzo email permanente.',
  listSep: ', ',
  listOr: ' o ',
};

const LOGIN_ERRORS_ES: LoginErrorTexts = {
  sessionExpired: 'Tu sesión ha caducado. Inténtalo de nuevo.',
  sessionEnded: 'Tu sesión ha caducado. Inicia sesión.',
  sessionExpiredSignIn: 'Tu sesión ha caducado. Vuelve a iniciar sesión.',
  signInAgain: 'Vuelve a iniciar sesión.',
  ssoUnavailable: 'El inicio de sesión único no está disponible. Contacta con tu administrador.',
  credentialsRequired: 'El correo y la contraseña son obligatorios',
  invalidCredentials: 'Correo o contraseña no válidos',
  signInFailed:
    'Ese correo y esa contraseña no coinciden. Si te registraste con {providers}, usa ese botón. ¿Eres nuevo? Crea primero una cuenta.',
  passwordDisabled:
    'El inicio de sesión con contraseña está desactivado para esta cuenta. Usa el inicio de sesión de tu organización.',
  verifyEmailFirst: 'Verifica primero tu dirección de correo: abre el enlace del correo que te enviamos.',
  optionUnavailable: 'Esta opción de inicio de sesión no está disponible.',
  optionUnavailableNow: 'Esta opción de inicio de sesión no está disponible en este momento.',
  wrongWorkspace:
    'El servidor MCP que estás conectando pertenece a otro workspace y esta cuenta no es miembro de él. ' +
    'Inicia sesión con una cuenta de ese workspace o pide a su administrador que te invite. ' +
    'Si no necesitas esta conexión, elimínala de tu asistente de IA.',
  noServersAvailable: 'Ninguno de los servidores seleccionados está disponible para ti. Inténtalo de nuevo.',
  chooseServer: 'Elige al menos un servidor MCP.',
  socialFailed: 'No se pudo iniciar sesión. Inténtalo de nuevo.',
  authorizationExpired: 'Tu solicitud de autorización ha caducado. Empieza de nuevo desde tu asistente de IA.',
  linkExpired: 'Este enlace de inicio de sesión ha caducado. Inténtalo de nuevo.',
  otherBrowser: 'No se pudo completar el inicio de sesión en este navegador. Inténtalo de nuevo.',
  cancelled: 'Se canceló el inicio de sesión.',
  providerFailed: 'El proveedor no pudo iniciar tu sesión. Inténtalo de nuevo.',
  ssoRequired: 'Tu organización exige su propio inicio de sesión único para esta cuenta.',
  noWorkspace: 'Esta cuenta no tiene ningún workspace activo.',
  providerNoEmail:
    'Tu cuenta de {provider} no compartió una dirección de correo verificada. Regístrate con tu dirección de correo.',
  providerUnverified:
    '{provider} no pudo confirmar tu dirección de correo. Regístrate con tu dirección de correo y después conecta {provider} en Ajustes.',
  ambiguousEmail: 'Inicia sesión con tu correo y tu contraseña y después conecta esta cuenta en Ajustes.',
  alreadyLinked: 'Tu cuenta ya está conectada a otra cuenta de {provider}.',
  registrationClosed: 'Los registros nuevos están cerrados en esta instancia.',
  disposableEmail: 'Usa una dirección de correo permanente.',
  listSep: ', ',
  listOr: ' o ',
};

const LOGIN_ERRORS_ZH: LoginErrorTexts = {
  sessionExpired: '会话已过期，请重试。',
  sessionEnded: '会话已过期，请登录。',
  sessionExpiredSignIn: '会话已过期，请重新登录。',
  signInAgain: '请重新登录。',
  ssoUnavailable: '单点登录不可用，请联系你的管理员。',
  credentialsRequired: '请输入电子邮件和密码',
  invalidCredentials: '电子邮件或密码无效',
  signInFailed:
    '电子邮件和密码不匹配。如果你是通过 {providers} 注册的，请改用对应的按钮。新用户？请先创建账户。',
  passwordDisabled: '此账户已停用密码登录。请使用你所在组织的登录方式。',
  verifyEmailFirst: '请先验证你的电子邮件地址：打开我们发给你的邮件中的链接。',
  optionUnavailable: '此登录方式不可用。',
  optionUnavailableNow: '此登录方式暂时不可用。',
  wrongWorkspace:
    '你要连接的 MCP 服务器属于另一个工作区，而此账户不是该工作区的成员。' +
    '请使用该工作区的账户登录，或请其管理员邀请你。' +
    '如果你不需要此连接，请在你的 AI 助手中将其移除。',
  noServersAvailable: '所选服务器均不可供你使用，请重试。',
  chooseServer: '请至少选择一个 MCP 服务器。',
  socialFailed: '登录失败，请重试。',
  authorizationExpired: '你的授权请求已过期。请从你的 AI 助手重新开始。',
  linkExpired: '此登录链接已过期，请重试。',
  otherBrowser: '无法在此浏览器中完成登录，请重试。',
  cancelled: '登录已取消。',
  providerFailed: '该服务商未能让你登录，请重试。',
  ssoRequired: '你所在的组织要求此账户使用其自己的单点登录。',
  noWorkspace: '此账户没有有效的工作区。',
  providerNoEmail: '你的 {provider} 账户未提供已验证的电子邮件地址。请改用你的电子邮件地址注册。',
  providerUnverified:
    '{provider} 无法确认你的电子邮件地址。请用你的电子邮件地址注册，然后在设置中连接 {provider}。',
  ambiguousEmail: '请使用电子邮件和密码登录，然后在设置中连接此账户。',
  alreadyLinked: '你的账户已连接到另一个 {provider} 账户。',
  registrationClosed: '此实例已关闭新用户注册。',
  disposableEmail: '请使用长期有效的电子邮件地址。',
  listSep: '、',
  listOr: ' 或 ',
};

const LOGIN_ERRORS_JA: LoginErrorTexts = {
  sessionExpired: 'セッションの有効期限が切れました。もう一度お試しください。',
  sessionEnded: 'セッションの有効期限が切れました。ログインしてください。',
  sessionExpiredSignIn: 'セッションの有効期限が切れました。もう一度ログインしてください。',
  signInAgain: 'もう一度ログインしてください。',
  ssoUnavailable: 'シングルサインオンは利用できません。管理者にお問い合わせください。',
  credentialsRequired: 'メールアドレスとパスワードを入力してください',
  invalidCredentials: 'メールアドレスまたはパスワードが正しくありません',
  signInFailed:
    'メールアドレスとパスワードが一致しません。{providers} で登録した場合は、そのボタンをお使いください。初めての方は、先にアカウントを作成してください。',
  passwordDisabled:
    'このアカウントではパスワードでのログインが無効になっています。組織のログイン方法をお使いください。',
  verifyEmailFirst: '先にメールアドレスを確認してください。お送りしたメール内のリンクを開いてください。',
  optionUnavailable: 'このログイン方法は利用できません。',
  optionUnavailableNow: 'このログイン方法は現在利用できません。',
  wrongWorkspace:
    '接続しようとしている MCP サーバーは別のワークスペースのもので、このアカウントはそのメンバーではありません。' +
    'そのワークスペースのアカウントでログインするか、管理者に招待を依頼してください。' +
    'この接続が不要な場合は、AI アシスタントから削除してください。',
  noServersAvailable: '選択したサーバーはいずれもご利用いただけません。もう一度お試しください。',
  chooseServer: 'MCP サーバーを 1 つ以上選択してください。',
  socialFailed: 'ログインに失敗しました。もう一度お試しください。',
  authorizationExpired: '認可リクエストの有効期限が切れました。AI アシスタントからやり直してください。',
  linkExpired: 'このログインリンクは有効期限が切れています。もう一度お試しください。',
  otherBrowser: 'このブラウザではログインを完了できませんでした。もう一度お試しください。',
  cancelled: 'ログインはキャンセルされました。',
  providerFailed: 'プロバイダーでログインできませんでした。もう一度お試しください。',
  ssoRequired: 'あなたの組織は、このアカウントに組織独自のシングルサインオンを必須としています。',
  noWorkspace: 'このアカウントには有効なワークスペースがありません。',
  providerNoEmail:
    '{provider} アカウントから確認済みのメールアドレスが提供されませんでした。代わりにメールアドレスで登録してください。',
  providerUnverified:
    '{provider} はあなたのメールアドレスを確認できませんでした。メールアドレスで登録してから、「設定」で {provider} を連携してください。',
  ambiguousEmail: 'メールアドレスとパスワードでログインしてから、「設定」でこのアカウントを連携してください。',
  alreadyLinked: 'あなたのアカウントは、すでに別の {provider} アカウントと連携されています。',
  registrationClosed: 'このインスタンスでは新規登録を受け付けていません。',
  disposableEmail: '継続して使えるメールアドレスをご利用ください。',
  listSep: '、',
  listOr: ' または ',
};

const LOGIN_ERRORS_RU: LoginErrorTexts = {
  sessionExpired: 'Сессия истекла. Попробуйте ещё раз.',
  sessionEnded: 'Сессия истекла. Войдите в аккаунт.',
  sessionExpiredSignIn: 'Сессия истекла. Войдите снова.',
  signInAgain: 'Войдите снова.',
  ssoUnavailable: 'Единый вход недоступен. Обратитесь к администратору.',
  credentialsRequired: 'Введите адрес электронной почты и пароль',
  invalidCredentials: 'Неверный адрес электронной почты или пароль',
  signInFailed:
    'Адрес и пароль не совпадают. Если вы регистрировались через {providers}, используйте эту кнопку. Впервые здесь? Сначала создайте аккаунт.',
  passwordDisabled: 'Вход по паролю для этого аккаунта отключён. Используйте вход вашей организации.',
  verifyEmailFirst:
    'Сначала подтвердите адрес электронной почты: откройте ссылку из письма, которое мы вам отправили.',
  optionUnavailable: 'Этот способ входа недоступен.',
  optionUnavailableNow: 'Этот способ входа сейчас недоступен.',
  wrongWorkspace:
    'MCP-сервер, который вы подключаете, принадлежит другому workspace, и этот аккаунт в него не входит. ' +
    'Войдите с аккаунтом этого workspace или попросите его администратора пригласить вас. ' +
    'Если это подключение вам не нужно, удалите его в вашем ИИ-ассистенте.',
  noServersAvailable: 'Ни один из выбранных серверов вам недоступен. Попробуйте ещё раз.',
  chooseServer: 'Выберите хотя бы один MCP-сервер.',
  socialFailed: 'Не удалось войти. Попробуйте ещё раз.',
  authorizationExpired: 'Срок запроса на авторизацию истёк. Начните заново из вашего ИИ-ассистента.',
  linkExpired: 'Срок действия этой ссылки для входа истёк. Попробуйте ещё раз.',
  otherBrowser: 'Не удалось завершить вход в этом браузере. Попробуйте ещё раз.',
  cancelled: 'Вход отменён.',
  providerFailed: 'Провайдеру не удалось выполнить вход. Попробуйте ещё раз.',
  ssoRequired: 'Ваша организация требует для этого аккаунта собственный единый вход.',
  noWorkspace: 'У этого аккаунта нет активного workspace.',
  providerNoEmail:
    'Ваш аккаунт {provider} не передал подтверждённый адрес электронной почты. Зарегистрируйтесь по адресу электронной почты.',
  providerUnverified:
    '{provider} не смог подтвердить ваш адрес электронной почты. Зарегистрируйтесь по адресу электронной почты, а затем подключите {provider} в настройках.',
  ambiguousEmail:
    'Войдите по адресу электронной почты и паролю, а затем подключите этот аккаунт в настройках.',
  alreadyLinked: 'Ваш аккаунт уже связан с другим аккаунтом {provider}.',
  registrationClosed: 'Регистрация новых пользователей на этом экземпляре закрыта.',
  disposableEmail: 'Используйте постоянный адрес электронной почты.',
  listSep: ', ',
  listOr: ' или ',
};

export const LOGIN_ERROR_TEXTS: Record<PageLanguage, LoginErrorTexts> = {
  en: LOGIN_ERRORS_EN,
  de: LOGIN_ERRORS_DE,
  it: LOGIN_ERRORS_IT,
  es: LOGIN_ERRORS_ES,
  zh: LOGIN_ERRORS_ZH,
  ja: LOGIN_ERRORS_JA,
  ru: LOGIN_ERRORS_RU,
};
export const loginErrorTexts = textsFor(LOGIN_ERROR_TEXTS);

/** A message of LoginErrorTexts (every key but the two list separators). */
export type LoginErrorKey = Exclude<keyof LoginErrorTexts, 'listSep' | 'listOr'>;

/** The messages that name the provider the person tried to sign in with. */
const PROVIDER_ERRORS: readonly LoginErrorKey[] = ['providerNoEmail', 'providerUnverified', 'alreadyLinked'];

const isLoginErrorKey = (key: string): key is LoginErrorKey =>
  Object.prototype.hasOwnProperty.call(LOGIN_ERRORS_EN, key) && key !== 'listSep' && key !== 'listOr';

/** A sign-in provider as the page knows it: its id (`google`) and its name (`Google`). */
export interface NamedProvider {
  id: string;
  name: string;
}

/** "Google, Microsoft or GitHub" in the language of `T`. */
export function orList(names: readonly string[], T: Pick<LoginErrorTexts, 'listSep' | 'listOr'>): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(T.listSep)}${T.listOr}${names[names.length - 1]}`;
}

/**
 * The value of `error` in a redirect to `/auth/login` for a message, already
 * URL-encoded: its key, with the provider's id for the three messages that
 * name one.
 */
export function loginErrorParam(key: LoginErrorKey, providerId?: string): string {
  return encodeURIComponent(providerId && PROVIDER_ERRORS.includes(key) ? `${key}:${providerId}` : key);
}

/**
 * Reads an `error` value: `key` or `key:provider`. Also recognises the
 * English text of a message, which is what the redirect carried before (a
 * page that was already open, a link in the browser's history) and what the
 * social sign-in service still raises. Null for any other text.
 */
function readLoginError(
  value: string,
  providers: readonly NamedProvider[],
): { key: LoginErrorKey; providerId?: string } | null {
  const code = /^([A-Za-z]{3,40})(?::([a-z0-9_-]{1,30}))?$/.exec(value);
  if (code && isLoginErrorKey(code[1])) return { key: code[1], ...(code[2] ? { providerId: code[2] } : {}) };
  for (const key of Object.keys(LOGIN_ERRORS_EN)) {
    if (!isLoginErrorKey(key)) continue;
    if (LOGIN_ERRORS_EN[key] === value) return { key };
    if (!PROVIDER_ERRORS.includes(key)) continue;
    const named = providers.find((p) => fill(LOGIN_ERRORS_EN[key], { provider: p.name }) === value);
    if (named) return { key, providerId: named.id };
  }
  const names = providers.map((p) => p.name);
  if (names.length && fill(LOGIN_ERRORS_EN.signInFailed, { providers: orList(names, LOGIN_ERRORS_EN) }) === value) {
    return { key: 'signInFailed' };
  }
  return null;
}

/**
 * The `error` value for an English message raised somewhere else (the social
 * sign-in service), already URL-encoded: the key of the message when it is
 * one of ours, so the page can show it in its language; the text itself
 * otherwise, shown as it is.
 */
export function loginErrorParamForText(text: string, providers: readonly NamedProvider[]): string {
  const known = readLoginError(text, providers);
  return known ? loginErrorParam(known.key, known.providerId) : encodeURIComponent(text);
}

/**
 * What the page shows for an `error` value, as plain text (escape it before
 * putting it into HTML): the message in the page's language when the value
 * is one of our keys or the English text of one, and the value itself for
 * any other text.
 *
 * `providers` are the sign-in buttons this deployment has: the refusal of an
 * e-mail and password names them, and says only "Invalid email or password"
 * where there are none.
 */
export function loginErrorText(value: string, lang: PageLanguage, providers: readonly NamedProvider[]): string {
  const known = readLoginError(value, providers);
  if (!known) return value;
  const T = loginErrorTexts(lang);
  if (known.key === 'signInFailed') {
    const names = providers.map((p) => p.name);
    return names.length ? fill(T.signInFailed, { providers: orList(names, T) }) : T.invalidCredentials;
  }
  if (PROVIDER_ERRORS.includes(known.key)) {
    const provider = providers.find((p) => p.id === known.providerId);
    return provider ? fill(T[known.key], { provider: provider.name }) : T.socialFailed;
  }
  return T[known.key];
}
