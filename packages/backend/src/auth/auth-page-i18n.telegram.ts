import type { PageLanguage } from './authorization-attempt';
import { textsFor } from './auth-page-i18n';

/**
 * The one-tap Telegram panel of the page after approving
 * (first-app-telegram.ts) in the seven languages of the trial pages.
 *
 * - The top-level keys are the panel's markup (plain words, no markup of
 *   their own; they are escaped when written into the page).
 * - `js` is plain text for the panel's script: embedded with `scriptTexts`,
 *   filled in the browser and written with `textContent`.
 * - `answers` is what the status and token routes send back as JSON and the
 *   panel displays. The token route's service (adapters/telegram-managed-bot.
 *   service.ts) answers in English: `telegramAnswerText` finds the same
 *   message here by its English text. A refusal that comes from Telegram or
 *   from the adapter's own credential check is not in this list and is shown
 *   as it comes.
 *
 * "Start" is the button Telegram shows in a bot's chat; each language uses
 * the label of Telegram's own translation.
 */
export interface TelegramPanelTexts {
  qrAlt: string;
  scan: string;
  openWeb: string;
  linkQrAlt: string;
  linkHint: string;
  /** The same hint on a computer, where the QR code is beside it. */
  linkHintQr: string;
  linkWeb: string;
  create: string;
  help: string;
  linkButton: string;
  pasteSummary: string;
  step1: string;
  step2: string;
  tokenLabel: string;
  save: string;
  js: {
    /** Stand-in for a client without a name (the page always has one). */
    theChat: string;
    connected: string;
    connectedBot: string; // {bot}
    ready: string; // {client}
    openBot: string;
    startHelp: string;
    twoSteps: string; // {client}
    lastStep: string; // {client}
    expired: string; // {client}
    linked: string;
    notAToken: string;
    checking: string;
    notSaved: string;
    added: string; // {client}
    waiting: string;
  };
  answers: {
    /** The request the page suggests once the bot is connected. */
    request: string;
    pageExpired: string;
    tryAgain: string;
    expiredContinue: string;
    notSaved: string;
    unavailable: string;
    alreadyConnected: string;
    notATokenStrict: string;
    checkFailed: string;
  };
}

const EN: TelegramPanelTexts = {
  qrAlt: 'QR code that opens Telegram to create your bot',
  scan: 'Scan with your phone',
  openWeb: 'or open Telegram Web in this browser',
  linkQrAlt: 'QR code that opens Telegram to link your bot',
  linkHint: 'Telegram opens our setup bot: press Start there, then come back here.',
  linkHintQr:
    'Telegram opens our setup bot: press Start there, then come back here. Bot made on your phone? Scan the code.',
  linkWeb: 'Or open it in Telegram Web',
  create: 'Create your Telegram bot',
  help: 'This creates a new bot that belongs to you: it appears in your own @BotFather list, and you can rename it, add a picture and use it with your customers. Already have a bot? Paste its token below.',
  linkButton: 'Changed the username? Link your bot',
  pasteSummary: 'Already have a bot? Paste its token',
  step1: 'In Telegram, open @BotFather and send /mybots (or /newbot for a new bot).',
  step2: 'Pick the bot, choose API Token, and paste the token here.',
  tokenLabel: 'Bot token',
  save: 'Save',
  js: {
    theChat: 'the chat',
    connected: 'Telegram is connected.',
    connectedBot: 'Telegram is connected: {bot}.',
    ready: 'Telegram is ready. Continue to {client} and ask, for example:',
    openBot: 'Open your bot and press Start',
    startHelp: 'Your bot can write to you once you have pressed Start in its chat.',
    twoSteps: 'Two steps left: press Start in your bot’s chat, then tap Continue to {client} below.',
    lastStep: 'Last step: tap Continue to {client} below.',
    expired: 'This link has expired. Go back to {client} and press Connect again.',
    linked: 'Your Telegram account is linked. Now create your bot: any username works.',
    notAToken:
      'This does not look like a bot token. Paste the whole value from @BotFather, like 123456789:AAH...',
    checking: 'Checking the token with Telegram…',
    notSaved: 'The token could not be saved. Try again.',
    added: 'Telegram added. Create its bot now, or continue and finish it in {client}.',
    waiting: 'Waiting for your bot…',
  },
  answers: {
    request: 'Send me a test message on Telegram.',
    pageExpired: 'This page has expired.',
    tryAgain: 'Try again.',
    expiredContinue: 'This page has expired. Continue, and finish Telegram in the chat.',
    notSaved: 'The token could not be saved. Try again.',
    unavailable: 'This is not available right now. Continue, and finish Telegram in the chat.',
    alreadyConnected: 'Telegram is already connected.',
    notATokenStrict:
      'This does not look like a bot token. Paste the whole value from @BotFather, like 123456789:AAH..., with nothing before or after it.',
    checkFailed:
      'The token could not be checked right now. Try again, or continue and finish Telegram in the chat.',
  },
};

const DE: TelegramPanelTexts = {
  qrAlt: 'QR-Code, der Telegram öffnet, um Ihren Bot zu erstellen',
  scan: 'Mit dem Smartphone scannen',
  openWeb: 'oder Telegram Web in diesem Browser öffnen',
  linkQrAlt: 'QR-Code, der Telegram öffnet, um Ihren Bot zu verknüpfen',
  linkHint:
    'Telegram öffnet unseren Einrichtungs-Bot: Tippen Sie dort auf „Starten“ und kommen Sie dann hierher zurück.',
  linkHintQr:
    'Telegram öffnet unseren Einrichtungs-Bot: Tippen Sie dort auf „Starten“ und kommen Sie dann hierher zurück. Bot auf dem Smartphone erstellt? Scannen Sie den Code.',
  linkWeb: 'Oder in Telegram Web öffnen',
  create: 'Ihren Telegram-Bot erstellen',
  help: 'Damit entsteht ein neuer Bot, der Ihnen gehört: Er erscheint in Ihrer eigenen @BotFather-Liste, und Sie können ihn umbenennen, ein Bild hinzufügen und ihn mit Ihren Kunden nutzen. Sie haben schon einen Bot? Fügen Sie unten sein Token ein.',
  linkButton: 'Benutzernamen geändert? Bot verknüpfen',
  pasteSummary: 'Sie haben schon einen Bot? Token einfügen',
  step1: 'Öffnen Sie in Telegram @BotFather und senden Sie /mybots (oder /newbot für einen neuen Bot).',
  step2: 'Wählen Sie den Bot, dann „API Token“, und fügen Sie das Token hier ein.',
  tokenLabel: 'Bot-Token',
  save: 'Speichern',
  js: {
    theChat: 'Ihrem Chat',
    connected: 'Telegram ist verbunden.',
    connectedBot: 'Telegram ist verbunden: {bot}.',
    ready: 'Telegram ist bereit. Gehen Sie weiter zu {client} und fragen Sie zum Beispiel:',
    openBot: 'Bot öffnen und auf „Starten“ tippen',
    startHelp: 'Ihr Bot kann Ihnen schreiben, sobald Sie in seinem Chat auf „Starten“ getippt haben.',
    twoSteps:
      'Noch zwei Schritte: Tippen Sie im Chat Ihres Bots auf „Starten“ und dann unten auf „Weiter zu {client}“.',
    lastStep: 'Letzter Schritt: Tippen Sie unten auf „Weiter zu {client}“.',
    expired: 'Dieser Link ist abgelaufen. Gehen Sie zurück zu {client} und klicken Sie erneut auf „Verbinden“.',
    linked: 'Ihr Telegram-Konto ist verknüpft. Erstellen Sie jetzt Ihren Bot: Jeder Benutzername funktioniert.',
    notAToken:
      'Das sieht nicht nach einem Bot-Token aus. Fügen Sie den ganzen Wert von @BotFather ein, etwa 123456789:AAH...',
    checking: 'Token wird bei Telegram geprüft…',
    notSaved: 'Das Token konnte nicht gespeichert werden. Versuchen Sie es erneut.',
    added:
      'Telegram hinzugefügt. Erstellen Sie jetzt den Bot, oder fahren Sie fort und schließen Sie die Einrichtung in {client} ab.',
    waiting: 'Warte auf Ihren Bot…',
  },
  answers: {
    request: 'Sende mir eine Testnachricht über Telegram.',
    pageExpired: 'Diese Seite ist abgelaufen.',
    tryAgain: 'Versuchen Sie es erneut.',
    expiredContinue: 'Diese Seite ist abgelaufen. Fahren Sie fort und schließen Sie Telegram im Chat ab.',
    notSaved: 'Das Token konnte nicht gespeichert werden. Versuchen Sie es erneut.',
    unavailable: 'Das ist gerade nicht verfügbar. Fahren Sie fort und schließen Sie Telegram im Chat ab.',
    alreadyConnected: 'Telegram ist bereits verbunden.',
    notATokenStrict:
      'Das sieht nicht nach einem Bot-Token aus. Fügen Sie den ganzen Wert von @BotFather ein, etwa 123456789:AAH..., ohne etwas davor oder danach.',
    checkFailed:
      'Das Token konnte gerade nicht geprüft werden. Versuchen Sie es erneut, oder fahren Sie fort und schließen Sie Telegram im Chat ab.',
  },
};

const IT: TelegramPanelTexts = {
  qrAlt: 'Codice QR che apre Telegram per creare il tuo bot',
  scan: 'Scansiona con il telefono',
  openWeb: 'oppure apri Telegram Web in questo browser',
  linkQrAlt: 'Codice QR che apre Telegram per collegare il tuo bot',
  linkHint: 'Telegram apre il nostro bot di configurazione: premi Avvia lì, poi torna qui.',
  linkHintQr:
    'Telegram apre il nostro bot di configurazione: premi Avvia lì, poi torna qui. Hai creato il bot dal telefono? Scansiona il codice.',
  linkWeb: 'Oppure aprilo in Telegram Web',
  create: 'Crea il tuo bot Telegram',
  help: 'Così crei un nuovo bot che appartiene a te: compare nel tuo elenco di @BotFather e puoi rinominarlo, aggiungere un’immagine e usarlo con i tuoi clienti. Hai già un bot? Incolla il suo token qui sotto.',
  linkButton: 'Hai cambiato lo username? Collega il tuo bot',
  pasteSummary: 'Hai già un bot? Incolla il suo token',
  step1: 'In Telegram, apri @BotFather e invia /mybots (oppure /newbot per un nuovo bot).',
  step2: 'Scegli il bot, seleziona API Token e incolla il token qui.',
  tokenLabel: 'Token del bot',
  save: 'Salva',
  js: {
    theChat: 'chat',
    connected: 'Telegram è collegato.',
    connectedBot: 'Telegram è collegato: {bot}.',
    ready: 'Telegram è pronto. Continua su {client} e chiedi, per esempio:',
    openBot: 'Apri il tuo bot e premi Avvia',
    startHelp: 'Il tuo bot potrà scriverti dopo che avrai premuto Avvia nella sua chat.',
    twoSteps:
      'Mancano due passaggi: premi Avvia nella chat del tuo bot, poi tocca “Continua su {client}” qui sotto.',
    lastStep: 'Ultimo passaggio: tocca “Continua su {client}” qui sotto.',
    expired: 'Questo link è scaduto. Torna a {client} e premi di nuovo “Connetti”.',
    linked: 'Il tuo account Telegram è collegato. Ora crea il tuo bot: va bene qualsiasi username.',
    notAToken:
      'Non sembra il token di un bot. Incolla l’intero valore ricevuto da @BotFather, ad esempio 123456789:AAH...',
    checking: 'Verifica del token con Telegram…',
    notSaved: 'Non è stato possibile salvare il token. Riprova.',
    added: 'Telegram aggiunto. Crea ora il suo bot, oppure continua e completalo in {client}.',
    waiting: 'In attesa del tuo bot…',
  },
  answers: {
    request: 'Mandami un messaggio di prova su Telegram.',
    pageExpired: 'Questa pagina è scaduta.',
    tryAgain: 'Riprova.',
    expiredContinue: 'Questa pagina è scaduta. Continua e completa Telegram nella chat.',
    notSaved: 'Non è stato possibile salvare il token. Riprova.',
    unavailable: 'Non è disponibile in questo momento. Continua e completa Telegram nella chat.',
    alreadyConnected: 'Telegram è già collegato.',
    notATokenStrict:
      'Non sembra il token di un bot. Incolla l’intero valore ricevuto da @BotFather, ad esempio 123456789:AAH..., senza nulla prima o dopo.',
    checkFailed:
      'Non è stato possibile verificare il token in questo momento. Riprova, oppure continua e completa Telegram nella chat.',
  },
};

const ES: TelegramPanelTexts = {
  qrAlt: 'Código QR que abre Telegram para crear tu bot',
  scan: 'Escanéalo con tu teléfono',
  openWeb: 'o abre Telegram Web en este navegador',
  linkQrAlt: 'Código QR que abre Telegram para vincular tu bot',
  linkHint: 'Telegram abre nuestro bot de configuración: pulsa Iniciar allí y vuelve aquí.',
  linkHintQr:
    'Telegram abre nuestro bot de configuración: pulsa Iniciar allí y vuelve aquí. ¿Creaste el bot en el teléfono? Escanea el código.',
  linkWeb: 'O ábrelo en Telegram Web',
  create: 'Crea tu bot de Telegram',
  help: 'Esto crea un bot nuevo que es tuyo: aparece en tu propia lista de @BotFather y puedes cambiarle el nombre, añadirle una imagen y usarlo con tus clientes. ¿Ya tienes un bot? Pega su token abajo.',
  linkButton: '¿Cambiaste el nombre de usuario? Vincula tu bot',
  pasteSummary: '¿Ya tienes un bot? Pega su token',
  step1: 'En Telegram, abre @BotFather y envía /mybots (o /newbot para un bot nuevo).',
  step2: 'Elige el bot, selecciona API Token y pega el token aquí.',
  tokenLabel: 'Token del bot',
  save: 'Guardar',
  js: {
    theChat: 'el chat',
    connected: 'Telegram está conectado.',
    connectedBot: 'Telegram está conectado: {bot}.',
    ready: 'Telegram está listo. Continúa en {client} y pide, por ejemplo:',
    openBot: 'Abre tu bot y pulsa Iniciar',
    startHelp: 'Tu bot podrá escribirte cuando hayas pulsado Iniciar en su chat.',
    twoSteps:
      'Quedan dos pasos: pulsa Iniciar en el chat de tu bot y después toca «Continuar en {client}» aquí abajo.',
    lastStep: 'Último paso: toca «Continuar en {client}» aquí abajo.',
    expired: 'Este enlace ha caducado. Vuelve a {client} y pulsa «Conectar» de nuevo.',
    linked: 'Tu cuenta de Telegram está vinculada. Ahora crea tu bot: sirve cualquier nombre de usuario.',
    notAToken: 'Esto no parece un token de bot. Pega el valor completo de @BotFather, como 123456789:AAH...',
    checking: 'Comprobando el token con Telegram…',
    notSaved: 'No se pudo guardar el token. Inténtalo de nuevo.',
    added: 'Telegram añadido. Crea ahora su bot, o continúa y termínalo en {client}.',
    waiting: 'Esperando a tu bot…',
  },
  answers: {
    request: 'Envíame un mensaje de prueba por Telegram.',
    pageExpired: 'Esta página ha caducado.',
    tryAgain: 'Inténtalo de nuevo.',
    expiredContinue: 'Esta página ha caducado. Continúa y termina Telegram en el chat.',
    notSaved: 'No se pudo guardar el token. Inténtalo de nuevo.',
    unavailable: 'Esto no está disponible en este momento. Continúa y termina Telegram en el chat.',
    alreadyConnected: 'Telegram ya está conectado.',
    notATokenStrict:
      'Esto no parece un token de bot. Pega el valor completo de @BotFather, como 123456789:AAH..., sin nada antes ni después.',
    checkFailed:
      'No se pudo comprobar el token en este momento. Inténtalo de nuevo, o continúa y termina Telegram en el chat.',
  },
};

const ZH: TelegramPanelTexts = {
  qrAlt: '用于打开 Telegram 并创建机器人的二维码',
  scan: '用手机扫描',
  openWeb: '或在此浏览器中打开 Telegram Web',
  linkQrAlt: '用于打开 Telegram 并关联机器人的二维码',
  linkHint: 'Telegram 会打开我们的设置机器人：在那里点击“开始”，然后回到这里。',
  linkHintQr:
    'Telegram 会打开我们的设置机器人：在那里点击“开始”，然后回到这里。机器人是在手机上创建的？请扫描二维码。',
  linkWeb: '或在 Telegram Web 中打开',
  create: '创建你的 Telegram 机器人',
  help: '这会创建一个属于你的新机器人：它会出现在你自己的 @BotFather 列表中，你可以重命名、添加头像，并用它与客户沟通。已经有机器人？请在下方粘贴它的 token。',
  linkButton: '改了用户名？关联你的机器人',
  pasteSummary: '已经有机器人？粘贴它的 token',
  step1: '在 Telegram 中打开 @BotFather 并发送 /mybots（新建机器人则发送 /newbot）。',
  step2: '选择机器人，点击 API Token，然后把 token 粘贴到这里。',
  tokenLabel: '机器人 token',
  save: '保存',
  js: {
    theChat: '对话',
    connected: 'Telegram 已连接。',
    connectedBot: 'Telegram 已连接：{bot}。',
    ready: 'Telegram 已就绪。继续前往 {client}，例如可以这样说：',
    openBot: '打开你的机器人并点击“开始”',
    startHelp: '在机器人的对话中点击“开始”后，它才能给你发消息。',
    twoSteps: '还剩两步：在机器人的对话中点击“开始”，然后点击下方的“继续前往 {client}”。',
    lastStep: '最后一步：点击下方的“继续前往 {client}”。',
    expired: '此链接已过期。请返回 {client}，再次点击“连接”。',
    linked: '你的 Telegram 账户已关联。现在创建你的机器人：任何用户名都可以。',
    notAToken: '这看起来不像机器人 token。请粘贴 @BotFather 提供的完整内容，例如 123456789:AAH...',
    checking: '正在通过 Telegram 检查 token…',
    notSaved: '无法保存 token，请重试。',
    added: '已添加 Telegram。现在创建它的机器人，或继续并在 {client} 中完成设置。',
    waiting: '正在等待你的机器人…',
  },
  answers: {
    request: '在 Telegram 上给我发一条测试消息。',
    pageExpired: '此页面已过期。',
    tryAgain: '请重试。',
    expiredContinue: '此页面已过期。请继续，并在对话中完成 Telegram 的设置。',
    notSaved: '无法保存 token，请重试。',
    unavailable: '此功能暂时不可用。请继续，并在对话中完成 Telegram 的设置。',
    alreadyConnected: 'Telegram 已连接。',
    notATokenStrict:
      '这看起来不像机器人 token。请粘贴 @BotFather 提供的完整内容，例如 123456789:AAH...，前后不要有其他内容。',
    checkFailed: '暂时无法检查 token。请重试，或继续并在对话中完成 Telegram 的设置。',
  },
};

const JA: TelegramPanelTexts = {
  qrAlt: 'Telegram を開いてボットを作成する QR コード',
  scan: 'スマートフォンでスキャン',
  openWeb: 'または、このブラウザで Telegram Web を開く',
  linkQrAlt: 'Telegram を開いてボットを連携する QR コード',
  linkHint:
    'Telegram で当社のセットアップ用ボットが開きます。そこで「開始」を押してから、このページに戻ってください。',
  linkHintQr:
    'Telegram で当社のセットアップ用ボットが開きます。そこで「開始」を押してから、このページに戻ってください。スマートフォンでボットを作成した場合は、コードをスキャンしてください。',
  linkWeb: 'または Telegram Web で開く',
  create: 'Telegram ボットを作成',
  help: 'あなた専用の新しいボットを作成します。ボットはあなたの @BotFather の一覧に表示され、名前の変更や画像の追加、お客様とのやり取りに利用できます。すでにボットをお持ちの場合は、下にトークンを貼り付けてください。',
  linkButton: 'ユーザー名を変更した場合：ボットを連携',
  pasteSummary: 'すでにボットをお持ちの場合：トークンを貼り付け',
  step1: 'Telegram で @BotFather を開き、/mybots を送信します（新しいボットは /newbot）。',
  step2: 'ボットを選び、API Token を選択して、トークンをここに貼り付けます。',
  tokenLabel: 'ボットトークン',
  save: '保存',
  js: {
    theChat: 'チャット',
    connected: 'Telegram を接続しました。',
    connectedBot: 'Telegram を接続しました（{bot}）。',
    ready: 'Telegram の準備ができました。{client} に進み、たとえば次のように依頼してください。',
    openBot: 'ボットを開いて「開始」を押す',
    startHelp: 'ボットのチャットで「開始」を押すと、ボットからメッセージが届くようになります。',
    twoSteps:
      'あと 2 ステップ：ボットのチャットで「開始」を押し、下の「{client} に進む」をタップしてください。',
    lastStep: '最後のステップ：下の「{client} に進む」をタップしてください。',
    expired: 'このリンクは有効期限が切れました。{client} に戻り、もう一度「接続」を押してください。',
    linked: 'Telegram アカウントを連携しました。ボットを作成してください。ユーザー名は何でもかまいません。',
    notAToken:
      'ボットトークンではないようです。@BotFather から受け取った値全体（例：123456789:AAH...）を貼り付けてください。',
    checking: 'Telegram でトークンを確認しています…',
    notSaved: 'トークンを保存できませんでした。もう一度お試しください。',
    added:
      'Telegram を追加しました。今すぐボットを作成するか、このまま進んで {client} で設定を完了してください。',
    waiting: 'ボットを待っています…',
  },
  answers: {
    request: 'Telegram でテストメッセージを送ってください。',
    pageExpired: 'このページは有効期限が切れました。',
    tryAgain: 'もう一度お試しください。',
    expiredContinue:
      'このページは有効期限が切れました。このまま進んで、チャットで Telegram の設定を完了してください。',
    notSaved: 'トークンを保存できませんでした。もう一度お試しください。',
    unavailable: '現在ご利用いただけません。このまま進んで、チャットで Telegram の設定を完了してください。',
    alreadyConnected: 'Telegram はすでに接続されています。',
    notATokenStrict:
      'ボットトークンではないようです。@BotFather から受け取った値全体（例：123456789:AAH...）を、前後に何も付けずに貼り付けてください。',
    checkFailed:
      '現在トークンを確認できません。もう一度試すか、このまま進んでチャットで Telegram の設定を完了してください。',
  },
};

const RU: TelegramPanelTexts = {
  qrAlt: 'QR-код, который открывает Telegram для создания вашего бота',
  scan: 'Отсканируйте телефоном',
  openWeb: 'или откройте Telegram Web в этом браузере',
  linkQrAlt: 'QR-код, который открывает Telegram для привязки вашего бота',
  linkHint: 'Telegram откроет нашего бота настройки: нажмите там «Запустить» и вернитесь сюда.',
  linkHintQr:
    'Telegram откроет нашего бота настройки: нажмите там «Запустить» и вернитесь сюда. Создали бота на телефоне? Отсканируйте код.',
  linkWeb: 'Или откройте в Telegram Web',
  create: 'Создать своего Telegram-бота',
  help: 'Так создаётся новый бот, который принадлежит вам: он появится в вашем списке в @BotFather, его можно переименовать, добавить картинку и использовать для общения с клиентами. Уже есть бот? Вставьте его токен ниже.',
  linkButton: 'Изменили имя бота? Привяжите его',
  pasteSummary: 'Уже есть бот? Вставьте его токен',
  step1: 'В Telegram откройте @BotFather и отправьте /mybots (или /newbot для нового бота).',
  step2: 'Выберите бота, нажмите API Token и вставьте токен сюда.',
  tokenLabel: 'Токен бота',
  save: 'Сохранить',
  js: {
    theChat: 'чат',
    connected: 'Telegram подключён.',
    connectedBot: 'Telegram подключён: {bot}.',
    ready: 'Telegram готов. Продолжите в {client} и попросите, например:',
    openBot: 'Откройте бота и нажмите «Запустить»',
    startHelp: 'Бот сможет писать вам, когда вы нажмёте «Запустить» в чате с ним.',
    twoSteps: 'Осталось два шага: нажмите «Запустить» в чате с ботом, затем «Продолжить в {client}» ниже.',
    lastStep: 'Последний шаг: нажмите «Продолжить в {client}» ниже.',
    expired: 'Срок действия этой ссылки истёк. Вернитесь в {client} и снова нажмите «Подключить».',
    linked: 'Ваш аккаунт Telegram привязан. Теперь создайте бота: подойдёт любое имя пользователя.',
    notAToken:
      'Это не похоже на токен бота. Вставьте значение из @BotFather целиком, например 123456789:AAH...',
    checking: 'Проверяем токен в Telegram…',
    notSaved: 'Не удалось сохранить токен. Попробуйте ещё раз.',
    added: 'Telegram добавлен. Создайте бота сейчас или продолжите и завершите настройку в {client}.',
    waiting: 'Ждём вашего бота…',
  },
  answers: {
    request: 'Отправь мне тестовое сообщение в Telegram.',
    pageExpired: 'Срок действия этой страницы истёк.',
    tryAgain: 'Попробуйте ещё раз.',
    expiredContinue: 'Срок действия этой страницы истёк. Продолжите и завершите настройку Telegram в чате.',
    notSaved: 'Не удалось сохранить токен. Попробуйте ещё раз.',
    unavailable: 'Сейчас это недоступно. Продолжите и завершите настройку Telegram в чате.',
    alreadyConnected: 'Telegram уже подключён.',
    notATokenStrict:
      'Это не похоже на токен бота. Вставьте значение из @BotFather целиком, например 123456789:AAH..., без чего-либо до или после него.',
    checkFailed:
      'Сейчас не удалось проверить токен. Попробуйте ещё раз или продолжите и завершите настройку Telegram в чате.',
  },
};

export const TELEGRAM_PANEL_TEXTS: Record<PageLanguage, TelegramPanelTexts> = {
  en: EN,
  de: DE,
  it: IT,
  es: ES,
  zh: ZH,
  ja: JA,
  ru: RU,
};
export const telegramPanelTexts = textsFor(TELEGRAM_PANEL_TEXTS);

/**
 * An answer of the Telegram routes in the page's language. `english` is the
 * message as the service wrote it: when it is one of `answers`, the same
 * message in `lang`; any other text (Telegram's own refusal of a token, for
 * one) comes back unchanged.
 */
export function telegramAnswerText(english: string, lang: PageLanguage | null | undefined): string {
  const keys = Object.keys(EN.answers) as Array<keyof TelegramPanelTexts['answers']>;
  const key = keys.find((k) => EN.answers[k] === english);
  return key ? telegramPanelTexts(lang).answers[key] : english;
}
