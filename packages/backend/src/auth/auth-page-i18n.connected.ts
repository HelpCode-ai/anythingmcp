import type { PageLanguage } from './authorization-attempt';
import { textsFor } from './auth-page-i18n';

/**
 * The page after approving into an empty workspace (`renderFirstConnectorOffer`,
 * GET /auth/next) in the seven languages of the trial pages: its markup, what
 * its scripts write into the page, and the answers of `POST /auth/first-app`
 * that the page displays.
 *
 * Three kinds of text, kept apart because they are escaped differently:
 * - the top-level keys are HTML (the caller escapes the values it fills in;
 *   `subNext` carries <strong>, `copyContinue` may carry `&amp;`);
 * - `js` is plain text for the page's scripts: embedded with `scriptTexts`,
 *   filled in the browser and written with `textContent`;
 * - `answers` and the two requests are plain text too: they go out as JSON
 *   (or into an escaped attribute) and the script writes them with
 *   `textContent`.
 */
export interface ConnectedPageTexts {
  /** The heading and tab title of the `next_step` page, and of the control page. */
  headingNext: string; // {client}
  headingControl: string; // {client}
  subNext: string; // {client}
  subControl: string; // {client}
  trialEnded: string; // {client}
  noApps: string;
  /** The quotation marks around the example request. */
  quoteOpen: string;
  quoteClose: string;
  copyContinue: string;
  copy: string;
  body: string; // {client}
  pickerTitle: string;
  otherApp: string;
  otherPlaceholder: string;
  stay: string;
  continueTo: string; // {client}
  addPayment: string;
  trialNote: string; // {date} {client}
  /** The `panel` arm of the trial offer test (authorization-attempt.ts). */
  offerTitle: string; // {date}
  offerBody: string; // {date}
  offerButton: string;
  offerFine: string; // {client}
  addHere: string;
  /** The request the page suggests typing into the chat (plain text). */
  example: string;
  /** Its text once an app was picked (plain text): {app}. */
  finishRequest: string;
  js: {
    copied: string;
    /** Stand-ins for a client without a name (the page always has one). */
    theChat: string;
    yourAssistant: string;
    couldNotAdd: string; // {name}
    adding: string; // {name}
    added: string; // {name} {client}
    connectMy: string; // {app}
    copiedPaste: string; // {client}
    pressContinue: string; // {client}
    goingBack: string; // {client} {seconds}
  };
  answers: {
    expired: string;
    unknownApp: string;
    cannotAddHere: string; // {app}
    adminsOnly: string;
    couldNotAdd: string; // {app}
  };
}

const EN: ConnectedPageTexts = {
  headingNext: 'One more step: go back to {client}',
  headingControl: '{client} is connected',
  subNext: 'Press <strong>Continue to {client}</strong> to finish connecting.',
  subControl:
    'Your workspace has no apps yet, so {client} has nothing to work with. You can add them right in the chat. For example, ask:',
  trialEnded:
    'Your free trial has ended. {client} will show you how to reactivate the workspace when you ask it something.',
  noApps: 'Your workspace has no apps yet: you can add them right in the chat. For example, ask:',
  quoteOpen: '“',
  quoteClose: '”',
  copyContinue: 'Copy &amp; continue',
  copy: 'Copy',
  body: '{client} finds the connector and sets it up with you. Passwords and keys are never typed into the chat: you get a link to enter them here.',
  pickerTitle: 'Optional: add an app to start with',
  otherApp: 'Another app',
  otherPlaceholder: 'e.g. HubSpot',
  stay: 'Stay on this page',
  continueTo: 'Continue to {client}',
  addPayment: 'Add a payment method (optional)',
  trialNote:
    'Your free trial runs until {date}. With a payment method your plan carries on after it; nothing is charged before {date}. Either way you come straight back to {client}.',
  offerTitle: 'Free until {date}. Keep it running after?',
  offerBody:
    'Add a payment method now: your trial gets the higher connector limit, and nothing stops when it ends. Nothing is charged before {date}; cancel before then and you pay nothing.',
  offerButton: 'Add a payment method · €0 today',
  offerFine: 'Card, PayPal and other methods. You come straight back to {client}.',
  addHere: 'Or add an app here first (new tab)',
  example: 'Connect my Telegram bot to AnythingMCP.',
  finishRequest: 'Finish setting up my {app} connector.',
  js: {
    copied: 'Copied',
    theChat: 'the chat',
    yourAssistant: 'your assistant',
    couldNotAdd: 'Could not add {name} right now. You can still continue and add it in the chat.',
    adding: 'Adding {name}…',
    added: '{name} added — you’ll finish it in {client}.',
    connectMy: 'Connect my {app} to AnythingMCP.',
    copiedPaste: 'Copied. Paste it in a new chat in {client}.',
    pressContinue: 'Press Continue to {client} when you are ready.',
    goingBack: 'Telegram is connected. Going back to {client} in {seconds} s…',
  },
  answers: {
    expired: 'This page has expired. Go back to your AI assistant and press Connect again.',
    unknownApp: 'Unknown app.',
    cannotAddHere: '{app} cannot be added here right now. Continue, and add it in the chat.',
    adminsOnly: 'Only workspace admins and editors can add apps. Continue, and ask an admin to add it.',
    couldNotAdd: '{app} could not be added right now. You can still continue and add it in the chat.',
  },
};

const DE: ConnectedPageTexts = {
  headingNext: 'Noch ein Schritt: zurück zu {client}',
  headingControl: '{client} ist verbunden',
  subNext: 'Klicken Sie auf <strong>Weiter zu {client}</strong>, um die Verbindung abzuschließen.',
  subControl:
    'Ihr Workspace hat noch keine Apps, daher hat {client} nichts, womit es arbeiten kann. Sie können sie direkt im Chat hinzufügen. Fragen Sie zum Beispiel:',
  trialEnded:
    'Ihre kostenlose Testphase ist beendet. {client} zeigt Ihnen, wie Sie den Workspace reaktivieren, sobald Sie dort etwas fragen.',
  noApps: 'Ihr Workspace hat noch keine Apps: Sie können sie direkt im Chat hinzufügen. Fragen Sie zum Beispiel:',
  quoteOpen: '„',
  quoteClose: '“',
  copyContinue: 'Kopieren &amp; weiter',
  copy: 'Kopieren',
  body: '{client} findet den Connector und richtet ihn mit Ihnen ein. Passwörter und Schlüssel werden nie in den Chat getippt: Sie erhalten einen Link, um sie hier einzugeben.',
  pickerTitle: 'Optional: eine App für den Start hinzufügen',
  otherApp: 'Andere App',
  otherPlaceholder: 'z. B. HubSpot',
  stay: 'Auf dieser Seite bleiben',
  continueTo: 'Weiter zu {client}',
  addPayment: 'Zahlungsmethode hinterlegen (optional)',
  trialNote:
    'Ihre kostenlose Testphase läuft bis zum {date}. Mit einer Zahlungsmethode läuft Ihr Tarif danach weiter; vor dem {date} wird nichts abgebucht. In beiden Fällen kommen Sie direkt zu {client} zurück.',
  offerTitle: 'Kostenlos bis zum {date}. Danach einfach weiter?',
  offerBody:
    'Hinterlegen Sie jetzt eine Zahlungsmethode: Ihre Testphase erhält das höhere Connector-Limit, und nach ihrem Ende läuft alles ohne Unterbrechung weiter. Vor dem {date} wird nichts abgebucht; kündigen Sie vorher, zahlen Sie nichts.',
  offerButton: 'Zahlungsmethode hinterlegen · heute 0 €',
  offerFine: 'Karte, PayPal und weitere Methoden. Danach geht es direkt zurück zu {client}.',
  addHere: 'Oder zuerst hier eine App hinzufügen (neuer Tab)',
  example: 'Verbinde meinen Telegram-Bot mit AnythingMCP.',
  finishRequest: 'Schließe die Einrichtung meines {app}-Connectors ab.',
  js: {
    copied: 'Kopiert',
    // Both follow "in" or "zu" (dative).
    theChat: 'Ihrem Chat',
    yourAssistant: 'Ihrem Assistenten',
    couldNotAdd:
      '{name} konnte gerade nicht hinzugefügt werden. Sie können trotzdem fortfahren und die App im Chat hinzufügen.',
    adding: '{name} wird hinzugefügt…',
    added: '{name} hinzugefügt – die Einrichtung schließen Sie in {client} ab.',
    connectMy: 'Verbinde mein {app} mit AnythingMCP.',
    copiedPaste: 'Kopiert. Fügen Sie es in {client} in einen neuen Chat ein.',
    pressContinue: 'Klicken Sie auf „Weiter zu {client}“, wenn Sie bereit sind.',
    goingBack: 'Telegram ist verbunden. Zurück zu {client} in {seconds} s…',
  },
  answers: {
    expired:
      'Diese Seite ist abgelaufen. Gehen Sie zurück zu Ihrem KI-Assistenten und klicken Sie erneut auf „Verbinden“.',
    unknownApp: 'Unbekannte App.',
    cannotAddHere:
      '{app} kann hier gerade nicht hinzugefügt werden. Fahren Sie fort und fügen Sie die App im Chat hinzu.',
    adminsOnly:
      'Nur Admins und Editoren des Workspace können Apps hinzufügen. Fahren Sie fort und bitten Sie einen Admin, die App hinzuzufügen.',
    couldNotAdd:
      '{app} konnte gerade nicht hinzugefügt werden. Sie können trotzdem fortfahren und die App im Chat hinzufügen.',
  },
};

const IT: ConnectedPageTexts = {
  headingNext: 'Ancora un passaggio: torna a {client}',
  headingControl: '{client} è collegato',
  subNext: 'Premi <strong>Continua su {client}</strong> per completare il collegamento.',
  subControl:
    'Il tuo workspace non ha ancora app, quindi {client} non ha nulla con cui lavorare. Puoi aggiungerle direttamente nella chat. Per esempio, chiedi:',
  trialEnded:
    'La tua prova gratuita è terminata. {client} ti mostrerà come riattivare il workspace quando gli chiederai qualcosa.',
  noApps: 'Il tuo workspace non ha ancora app: puoi aggiungerle direttamente nella chat. Per esempio, chiedi:',
  quoteOpen: '“',
  quoteClose: '”',
  copyContinue: 'Copia e continua',
  copy: 'Copia',
  body: '{client} trova il connettore e lo configura con te. Password e chiavi non vengono mai scritte nella chat: ricevi un link per inserirle qui.',
  pickerTitle: 'Facoltativo: aggiungi un’app per iniziare',
  otherApp: 'Un’altra app',
  otherPlaceholder: 'es. HubSpot',
  stay: 'Resta su questa pagina',
  continueTo: 'Continua su {client}',
  addPayment: 'Metodo di pagamento (facoltativo)',
  // "il giorno" keeps the article right before any day (l’8, l’11).
  trialNote:
    'La tua prova gratuita dura fino al giorno {date}. Con un metodo di pagamento il tuo piano prosegue dopo la prova; nessun addebito prima del giorno {date}. In ogni caso torni subito a {client}.',
  offerTitle: 'Gratis fino al giorno {date}. Vuoi che poi continui?',
  offerBody:
    'Aggiungi ora un metodo di pagamento: la prova ottiene il limite di connettori più alto e alla fine non si interrompe nulla. Nessun addebito prima del giorno {date}; se disdici prima, non paghi niente.',
  offerButton: 'Aggiungi un metodo di pagamento · 0 € oggi',
  offerFine: 'Carta, PayPal e altri metodi. Poi torni subito a {client}.',
  addHere: 'Oppure aggiungi prima un’app qui (nuova scheda)',
  example: 'Collega il mio bot Telegram ad AnythingMCP.',
  finishRequest: 'Completa la configurazione del mio connettore {app}.',
  js: {
    copied: 'Copiato',
    theChat: 'chat',
    yourAssistant: 'assistente AI',
    couldNotAdd:
      'Non è stato possibile aggiungere {name} in questo momento. Puoi comunque continuare e aggiungerlo nella chat.',
    adding: 'Aggiunta di {name} in corso…',
    added: '{name} aggiunto: completerai la configurazione in {client}.',
    connectMy: 'Collega il mio {app} ad AnythingMCP.',
    copiedPaste: 'Copiato. Incollalo in una nuova chat su {client}.',
    pressContinue: 'Premi “Continua su {client}” quando vuoi.',
    goingBack: 'Telegram è collegato. Ritorno a {client} tra {seconds} s…',
  },
  answers: {
    expired: 'Questa pagina è scaduta. Torna al tuo assistente AI e premi di nuovo “Connetti”.',
    unknownApp: 'App sconosciuta.',
    cannotAddHere: 'Al momento {app} non può essere aggiunto qui. Continua e aggiungilo nella chat.',
    adminsOnly:
      'Solo gli admin e gli editor del workspace possono aggiungere app. Continua e chiedi a un admin di aggiungerla.',
    couldNotAdd:
      'Non è stato possibile aggiungere {app} in questo momento. Puoi comunque continuare e aggiungerlo nella chat.',
  },
};

const ES: ConnectedPageTexts = {
  headingNext: 'Un paso más: vuelve a {client}',
  headingControl: '{client} está conectado',
  subNext: 'Pulsa <strong>Continuar en {client}</strong> para terminar de conectar.',
  subControl:
    'Tu workspace aún no tiene apps, así que {client} no tiene con qué trabajar. Puedes añadirlas directamente en el chat. Por ejemplo, pide:',
  trialEnded:
    'Tu prueba gratuita ha terminado. {client} te mostrará cómo reactivar el workspace cuando le pidas algo.',
  noApps: 'Tu workspace aún no tiene apps: puedes añadirlas directamente en el chat. Por ejemplo, pide:',
  quoteOpen: '«',
  quoteClose: '»',
  copyContinue: 'Copiar y continuar',
  copy: 'Copiar',
  body: '{client} encuentra el conector y lo configura contigo. Las contraseñas y las claves nunca se escriben en el chat: recibes un enlace para introducirlas aquí.',
  pickerTitle: 'Opcional: añade una app para empezar',
  otherApp: 'Otra app',
  otherPlaceholder: 'p. ej., HubSpot',
  stay: 'Quedarme en esta página',
  continueTo: 'Continuar en {client}',
  addPayment: 'Añadir un método de pago (opcional)',
  trialNote:
    'Tu prueba gratuita dura hasta el {date}. Con un método de pago, tu plan continúa después; no se cobra nada antes del {date}. En cualquier caso, vuelves directamente a {client}.',
  offerTitle: 'Gratis hasta el {date}. ¿Quieres que siga después?',
  offerBody:
    'Añade ahora un método de pago: tu prueba obtiene el límite de conectores más alto y nada se detiene cuando termina. No se cobra nada antes del {date}; si cancelas antes, no pagas nada.',
  offerButton: 'Añadir un método de pago · 0 € hoy',
  offerFine: 'Tarjeta, PayPal y otros métodos. Después vuelves directamente a {client}.',
  addHere: 'O añade antes una app aquí (pestaña nueva)',
  example: 'Conecta mi bot de Telegram a AnythingMCP.',
  finishRequest: 'Termina de configurar mi conector de {app}.',
  js: {
    copied: 'Copiado',
    theChat: 'el chat',
    yourAssistant: 'tu asistente',
    couldNotAdd:
      'No se ha podido añadir {name} en este momento. Puedes continuar igualmente y añadirla en el chat.',
    adding: 'Añadiendo {name}…',
    added: '{name} añadido: terminarás de configurarlo en {client}.',
    connectMy: 'Conecta mi {app} a AnythingMCP.',
    copiedPaste: 'Copiado. Pégalo en un chat nuevo en {client}.',
    pressContinue: 'Pulsa «Continuar en {client}» cuando quieras.',
    goingBack: 'Telegram está conectado. Volviendo a {client} en {seconds} s…',
  },
  answers: {
    expired: 'Esta página ha caducado. Vuelve a tu asistente de IA y pulsa «Conectar» de nuevo.',
    unknownApp: 'App desconocida.',
    cannotAddHere: 'Ahora mismo {app} no se puede añadir aquí. Continúa y añádela en el chat.',
    adminsOnly:
      'Solo los administradores y editores del workspace pueden añadir apps. Continúa y pide a un administrador que la añada.',
    couldNotAdd:
      'No se ha podido añadir {app} en este momento. Puedes continuar igualmente y añadirla en el chat.',
  },
};

const ZH: ConnectedPageTexts = {
  headingNext: '还差一步：返回 {client}',
  headingControl: '{client} 已连接',
  subNext: '点击<strong>继续前往 {client}</strong>即可完成连接。',
  subControl:
    '你的工作区还没有应用，所以 {client} 暂时没有可用的内容。你可以直接在对话中添加。例如，可以这样说：',
  trialEnded: '你的免费试用已结束。当你向 {client} 提问时，它会告诉你如何重新激活工作区。',
  noApps: '你的工作区还没有应用：你可以直接在对话中添加。例如，可以这样说：',
  quoteOpen: '“',
  quoteClose: '”',
  copyContinue: '复制并继续',
  copy: '复制',
  body: '{client} 会找到对应的连接器并和你一起完成设置。密码和密钥绝不会输入到对话中：你会收到一个链接，在这里填写。',
  pickerTitle: '可选：先添加一个应用',
  otherApp: '其他应用',
  otherPlaceholder: '例如 HubSpot',
  stay: '留在此页面',
  continueTo: '继续前往 {client}',
  addPayment: '添加付款方式（可选）',
  trialNote:
    '你的免费试用到 {date} 结束。添加付款方式后，套餐会在试用结束后自动延续；{date} 之前不会扣款。无论如何，你都会直接回到 {client}。',
  offerTitle: '{date} 前免费。之后要继续使用吗？',
  offerBody:
    '现在添加付款方式：试用期可获得更高的连接器上限，试用结束后也不会中断。{date} 之前不会扣款；在此之前取消则无需付费。',
  offerButton: '添加付款方式 · 今天 €0',
  offerFine: '支持银行卡、PayPal 等方式。完成后直接回到 {client}。',
  addHere: '或先在这里添加应用（新标签页）',
  example: '把我的 Telegram 机器人连接到 AnythingMCP。',
  finishRequest: '帮我完成 {app} 连接器的设置。',
  js: {
    copied: '已复制',
    theChat: '对话',
    yourAssistant: '你的助手',
    couldNotAdd: '暂时无法添加 {name}。你仍然可以继续，并在对话中添加。',
    adding: '正在添加 {name}…',
    added: '已添加 {name}，你将在 {client} 中完成设置。',
    connectMy: '把我的 {app} 连接到 AnythingMCP。',
    copiedPaste: '已复制。请粘贴到 {client} 的新对话中。',
    pressContinue: '准备好后，请点击“继续前往 {client}”。',
    goingBack: 'Telegram 已连接。{seconds} 秒后返回 {client}…',
  },
  answers: {
    expired: '此页面已过期。请返回你的 AI 助手，再次点击“连接”。',
    unknownApp: '未知应用。',
    cannotAddHere: '暂时无法在这里添加 {app}。请继续，并在对话中添加。',
    adminsOnly: '只有工作区的管理员和编辑者可以添加应用。请继续，并请管理员添加。',
    couldNotAdd: '暂时无法添加 {app}。你仍然可以继续，并在对话中添加。',
  },
};

const JA: ConnectedPageTexts = {
  headingNext: 'あと 1 ステップ：{client} に戻る',
  headingControl: '{client} を接続しました',
  subNext: '<strong>{client} に進む</strong>を押すと接続が完了します。',
  subControl:
    'ワークスペースにはまだアプリがないため、{client} が使えるものがありません。アプリはチャットから直接追加できます。たとえば、次のように依頼してください。',
  trialEnded:
    '無料トライアルは終了しました。{client} に何か依頼すると、ワークスペースを再開する方法が案内されます。',
  noApps:
    'ワークスペースにはまだアプリがありません。チャットから直接追加できます。たとえば、次のように依頼してください。',
  quoteOpen: '「',
  quoteClose: '」',
  copyContinue: 'コピーして進む',
  copy: 'コピー',
  body: '{client} がコネクタを見つけ、一緒に設定します。パスワードやキーをチャットに入力することはありません。入力用のリンクが届き、このサイトで入力します。',
  pickerTitle: '任意：最初に使うアプリを追加',
  otherApp: 'その他のアプリ',
  otherPlaceholder: '例：HubSpot',
  stay: 'このページにとどまる',
  continueTo: '{client} に進む',
  addPayment: 'お支払い方法を登録（任意）',
  trialNote:
    '無料トライアルは {date} までです。お支払い方法を登録すると、その後もプランが継続します。{date} より前に請求されることはありません。どちらの場合も、すぐに {client} に戻ります。',
  offerTitle: '{date} まで無料。その後も続けますか？',
  offerBody:
    '今お支払い方法を登録すると、トライアル中のコネクタ上限が引き上げられ、終了後も中断なく使えます。{date} より前に請求されることはなく、それまでに解約すれば料金はかかりません。',
  offerButton: 'お支払い方法を登録 · 本日 €0',
  offerFine: 'カード、PayPal などに対応。登録後はすぐに {client} に戻ります。',
  addHere: 'または、先にここでアプリを追加（新しいタブ）',
  example: 'Telegram ボットを AnythingMCP に接続してください。',
  finishRequest: '{app} コネクタの設定を完了してください。',
  js: {
    copied: 'コピーしました',
    theChat: 'チャット',
    yourAssistant: 'アシスタント',
    couldNotAdd: '現在 {name} を追加できません。このまま進んで、チャットで追加することもできます。',
    adding: '{name} を追加しています…',
    added: '{name} を追加しました。設定は {client} で完了します。',
    connectMy: '{app} を AnythingMCP に接続してください。',
    copiedPaste: 'コピーしました。{client} の新しいチャットに貼り付けてください。',
    pressContinue: '準備ができたら「{client} に進む」を押してください。',
    goingBack: 'Telegram を接続しました。{seconds} 秒後に {client} に戻ります…',
  },
  answers: {
    expired:
      'このページは有効期限が切れました。AI アシスタントに戻り、もう一度「接続」を押してください。',
    unknownApp: '不明なアプリです。',
    cannotAddHere: '現在、ここでは {app} を追加できません。このまま進んで、チャットで追加してください。',
    adminsOnly:
      'アプリを追加できるのは、ワークスペースの管理者と編集者だけです。このまま進んで、管理者に追加を依頼してください。',
    couldNotAdd: '現在 {app} を追加できません。このまま進んで、チャットで追加することもできます。',
  },
};

const RU: ConnectedPageTexts = {
  headingNext: 'Ещё один шаг: вернитесь в {client}',
  headingControl: '{client} подключён',
  subNext: 'Нажмите <strong>Продолжить в {client}</strong>, чтобы завершить подключение.',
  subControl:
    'В вашем workspace пока нет приложений, поэтому {client} не с чем работать. Их можно добавить прямо в чате. Например, попросите:',
  trialEnded:
    'Ваш бесплатный пробный период закончился. {client} покажет, как возобновить работу workspace, когда вы о чём-нибудь его попросите.',
  noApps: 'В вашем workspace пока нет приложений: их можно добавить прямо в чате. Например, попросите:',
  quoteOpen: '«',
  quoteClose: '»',
  copyContinue: 'Копировать и далее',
  copy: 'Копировать',
  body: '{client} найдёт коннектор и настроит его вместе с вами. Пароли и ключи никогда не вводятся в чат: вы получите ссылку, чтобы ввести их здесь.',
  pickerTitle: 'По желанию: добавьте первое приложение',
  otherApp: 'Другое приложение',
  otherPlaceholder: 'например, HubSpot',
  stay: 'Остаться на этой странице',
  continueTo: 'Продолжить в {client}',
  addPayment: 'Способ оплаты (необязательно)',
  trialNote:
    'Ваш бесплатный пробный период действует до {date}. Со способом оплаты тариф продолжится после него; до {date} ничего не спишется. В любом случае вы сразу вернётесь в {client}.',
  offerTitle: 'Бесплатно до {date}. Продолжить и после?',
  offerBody:
    'Добавьте способ оплаты сейчас: в пробный период лимит коннекторов будет выше, а после его окончания ничего не прервётся. До {date} ничего не спишется; отмените раньше — и ничего не заплатите.',
  offerButton: 'Добавить способ оплаты · сегодня 0 €',
  offerFine: 'Карта, PayPal и другие способы. Затем вы сразу вернётесь в {client}.',
  addHere: 'Или сначала добавьте приложение здесь (новая вкладка)',
  example: 'Подключи моего Telegram-бота к AnythingMCP.',
  finishRequest: 'Заверши настройку моего коннектора {app}.',
  js: {
    copied: 'Скопировано',
    theChat: 'чат',
    yourAssistant: 'ваш ассистент',
    couldNotAdd: 'Сейчас не удалось добавить {name}. Вы можете продолжить и добавить приложение в чате.',
    adding: 'Добавляем {name}…',
    added: '{name} добавлен — настройку вы завершите в {client}.',
    connectMy: 'Подключи мой {app} к AnythingMCP.',
    copiedPaste: 'Скопировано. Вставьте в новый чат в {client}.',
    pressContinue: 'Нажмите «Продолжить в {client}», когда будете готовы.',
    goingBack: 'Telegram подключён. Возврат в {client} через {seconds} с…',
  },
  answers: {
    expired:
      'Срок действия этой страницы истёк. Вернитесь в ваш ИИ-ассистент и снова нажмите «Подключить».',
    unknownApp: 'Неизвестное приложение.',
    cannotAddHere: 'Сейчас {app} нельзя добавить здесь. Продолжите и добавьте приложение в чате.',
    adminsOnly:
      'Добавлять приложения могут только администраторы и редакторы workspace. Продолжите и попросите администратора добавить его.',
    couldNotAdd: 'Сейчас не удалось добавить {app}. Вы можете продолжить и добавить приложение в чате.',
  },
};

export const CONNECTED_PAGE_TEXTS: Record<PageLanguage, ConnectedPageTexts> = {
  en: EN,
  de: DE,
  it: IT,
  es: ES,
  zh: ZH,
  ja: JA,
  ru: RU,
};
export const connectedPageTexts = textsFor(CONNECTED_PAGE_TEXTS);
