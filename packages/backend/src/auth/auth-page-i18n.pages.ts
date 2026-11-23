import type { PageLanguage } from './authorization-attempt';
import { textsFor } from './auth-page-i18n';

/**
 * The pages at the edges of the flow in the seven languages of the trial
 * pages: "no longer open", "Too many attempts", "Request Cancelled" and the
 * two File Search pages.
 *
 * Same rules as in auth-page-i18n.ts: placeholders in braces are replaced by
 * `fill`, values are HTML-escaped by the caller, and a text contains only the
 * markup written here (<strong>).
 */

/** `renderClosedRequestPage`: the connection request expired, was used, or never existed here. */
export interface ClosedRequestTexts {
  heading: string;
  what: string;
  next: string;
  dashboardLead: string;
  dashboardLink: string;
}

/** The page a rate limit answers a person with (auth-page-throttle.filter.ts). */
export interface RateLimitTexts {
  heading: string;
  body: string;
  back: string;
}

/** "Request Cancelled", when the client has no address to be told at. */
export interface CancelledTexts {
  heading: string;
  body: string;
}

/** The File Search plugin's folder page, and the page its wizard returns to once the request is gone. */
export interface FileSearchTexts {
  heading: string; // {client}
  sub: string; // {client}
  optionsLabel: string;
  /**
   * Labels and hints of FILE_SEARCH_SETUP_OPTIONS that are words, by option
   * id. Protocol and product names (SFTP, Nextcloud, …) are not listed: they
   * are the same in every language.
   */
  optionLabels: { s3: string; local: string };
  optionHints: { sftp: string; ftps: string; ftp: string; webdav: string; local: string };
  step1: string;
  step2: string;
  step3: string; // {client}
  body: string; // {client}
  skip: string; // {client}
  doneHeading: string;
  done1: string;
  done2: string;
}

export interface EdgePageTexts {
  closed: ClosedRequestTexts;
  rateLimit: RateLimitTexts;
  cancelled: CancelledTexts;
  fileSearch: FileSearchTexts;
}

const EN: EdgePageTexts = {
  closed: {
    heading: 'This connection request is no longer open',
    what: 'A connection request stays open for 30 minutes and works once.',
    next: '<strong>Go back to your AI assistant.</strong> If AnythingMCP is not shown as connected there, press <strong>Connect</strong> again.',
    dashboardLead: 'Looking for the dashboard?',
    dashboardLink: 'Open AnythingMCP',
  },
  rateLimit: {
    heading: 'Too many attempts',
    body: 'Wait a minute, then try again. Your connection request stays open for 30 minutes.',
    back: 'Back to the sign-in page',
  },
  cancelled: {
    heading: 'Request Cancelled',
    body: 'The authorization request was declined. No access was granted. You can safely close this window.',
  },
  fileSearch: {
    heading: 'Connect a folder for {client}',
    sub: '{client} can search the documents on your file server once a folder is connected. Choose how AnythingMCP reaches it:',
    optionsLabel: 'How to reach the folder',
    optionLabels: { s3: 'S3-compatible storage', local: 'Network folder' },
    optionHints: {
      sftp: 'Linux or Windows server, most NAS',
      ftps: 'FTP with TLS encryption',
      ftp: 'Unencrypted, only when nothing else works',
      webdav: 'Any WebDAV share',
      local: 'A folder mounted into this server',
    },
    step1: 'Enter the server address and a read-only account, and test the connection.',
    step2: 'Pick the folders and file types to search, and see how many files that is.',
    step3: 'Check the description {client} reads, then activate: the first sync starts.',
    body: 'It takes about five minutes. Passwords and keys are entered on the next page, never in the chat. When the folder is active you come back here and on to {client}.',
    skip: 'Skip for now and continue to {client}',
    doneHeading: 'Go back to the chat to finish',
    done1:
      'The connection request from the chat timed out in the meantime. A folder you connected is saved and its first sync is running.',
    done2: 'Go back to the chat and connect the plugin again. It takes a few seconds now.',
  },
};

const DE: EdgePageTexts = {
  closed: {
    heading: 'Diese Verbindungsanfrage ist nicht mehr offen',
    what: 'Eine Verbindungsanfrage bleibt 30 Minuten offen und funktioniert einmal.',
    next: '<strong>Gehen Sie zurück zu Ihrem KI-Assistenten.</strong> Wenn AnythingMCP dort nicht als verbunden angezeigt wird, klicken Sie erneut auf <strong>Verbinden</strong>.',
    dashboardLead: 'Sie suchen das Dashboard?',
    dashboardLink: 'AnythingMCP öffnen',
  },
  rateLimit: {
    heading: 'Zu viele Versuche',
    body: 'Warten Sie eine Minute und versuchen Sie es dann erneut. Ihre Verbindungsanfrage bleibt 30 Minuten offen.',
    back: 'Zurück zur Anmeldeseite',
  },
  cancelled: {
    heading: 'Anfrage abgebrochen',
    body: 'Die Autorisierungsanfrage wurde abgelehnt. Es wurde kein Zugriff gewährt. Sie können dieses Fenster jetzt schließen.',
  },
  fileSearch: {
    heading: 'Einen Ordner für {client} verbinden',
    sub: '{client} kann die Dokumente auf Ihrem Dateiserver durchsuchen, sobald ein Ordner verbunden ist. Wählen Sie, wie AnythingMCP ihn erreicht:',
    optionsLabel: 'So wird der Ordner erreicht',
    optionLabels: { s3: 'S3-kompatibler Speicher', local: 'Netzwerkordner' },
    optionHints: {
      sftp: 'Linux- oder Windows-Server, die meisten NAS',
      ftps: 'FTP mit TLS-Verschlüsselung',
      ftp: 'Unverschlüsselt, nur wenn nichts anderes geht',
      webdav: 'Jede WebDAV-Freigabe',
      local: 'Ein Ordner, der in diesen Server eingebunden ist',
    },
    step1: 'Geben Sie die Serveradresse und ein Konto mit Lesezugriff ein und testen Sie die Verbindung.',
    step2: 'Wählen Sie die Ordner und Dateitypen für die Suche und sehen Sie, wie viele Dateien das sind.',
    step3:
      'Prüfen Sie die Beschreibung, die {client} liest, und aktivieren Sie dann: Die erste Synchronisierung startet.',
    body: 'Das dauert etwa fünf Minuten. Passwörter und Schlüssel geben Sie auf der nächsten Seite ein, nie im Chat. Sobald der Ordner aktiv ist, kommen Sie hierher zurück und weiter zu {client}.',
    skip: 'Vorerst überspringen und weiter zu {client}',
    doneHeading: 'Gehen Sie zum Abschluss zurück in den Chat',
    done1:
      'Die Verbindungsanfrage aus dem Chat ist inzwischen abgelaufen. Ein Ordner, den Sie verbunden haben, ist gespeichert, und seine erste Synchronisierung läuft.',
    done2:
      'Gehen Sie zurück in den Chat und verbinden Sie das Plugin erneut. Das dauert jetzt nur wenige Sekunden.',
  },
};

const IT: EdgePageTexts = {
  closed: {
    heading: 'Questa richiesta di connessione non è più aperta',
    what: 'Una richiesta di connessione resta aperta per 30 minuti e funziona una sola volta.',
    next: '<strong>Torna al tuo assistente AI.</strong> Se lì AnythingMCP non risulta collegato, premi di nuovo <strong>Connetti</strong>.',
    dashboardLead: 'Cerchi la dashboard?',
    dashboardLink: 'Apri AnythingMCP',
  },
  rateLimit: {
    heading: 'Troppi tentativi',
    body: 'Attendi un minuto, poi riprova. La tua richiesta di connessione resta aperta per 30 minuti.',
    back: 'Torna alla pagina di accesso',
  },
  cancelled: {
    heading: 'Richiesta annullata',
    body: 'La richiesta di autorizzazione è stata rifiutata. Non è stato concesso alcun accesso. Puoi chiudere questa finestra.',
  },
  fileSearch: {
    heading: 'Collega una cartella per {client}',
    sub: '{client} può cercare nei documenti del tuo file server una volta collegata una cartella. Scegli come AnythingMCP la raggiunge:',
    optionsLabel: 'Come raggiungere la cartella',
    optionLabels: { s3: 'Storage compatibile con S3', local: 'Cartella di rete' },
    optionHints: {
      sftp: 'Server Linux o Windows, la maggior parte dei NAS',
      ftps: 'FTP con crittografia TLS',
      ftp: 'Non cifrato, solo se non funziona altro',
      webdav: 'Qualsiasi condivisione WebDAV',
      local: 'Una cartella montata in questo server',
    },
    step1: 'Inserisci l’indirizzo del server e un account di sola lettura, poi prova la connessione.',
    step2: 'Scegli le cartelle e i tipi di file in cui cercare e guarda quanti file sono.',
    step3: 'Controlla la descrizione che {client} legge, poi attiva: parte la prima sincronizzazione.',
    body: 'Servono circa cinque minuti. Password e chiavi si inseriscono nella pagina successiva, mai nella chat. Quando la cartella è attiva torni qui e poi a {client}.',
    skip: 'Salta per ora e continua su {client}',
    doneHeading: 'Torna alla chat per completare',
    done1:
      'Nel frattempo la richiesta di connessione dalla chat è scaduta. La cartella che hai collegato è salvata e la sua prima sincronizzazione è in corso.',
    done2: 'Torna alla chat e collega di nuovo il plugin. Ora bastano pochi secondi.',
  },
};

const ES: EdgePageTexts = {
  closed: {
    heading: 'Esta solicitud de conexión ya no está abierta',
    what: 'Una solicitud de conexión permanece abierta 30 minutos y funciona una sola vez.',
    next: '<strong>Vuelve a tu asistente de IA.</strong> Si AnythingMCP no aparece allí como conectado, pulsa <strong>Conectar</strong> de nuevo.',
    dashboardLead: '¿Buscas el panel?',
    dashboardLink: 'Abrir AnythingMCP',
  },
  rateLimit: {
    heading: 'Demasiados intentos',
    body: 'Espera un minuto y vuelve a intentarlo. Tu solicitud de conexión permanece abierta 30 minutos.',
    back: 'Volver a la página de inicio de sesión',
  },
  cancelled: {
    heading: 'Solicitud cancelada',
    body: 'La solicitud de autorización se ha rechazado. No se ha concedido ningún acceso. Puedes cerrar esta ventana.',
  },
  fileSearch: {
    heading: 'Conecta una carpeta para {client}',
    sub: '{client} puede buscar en los documentos de tu servidor de archivos una vez conectada una carpeta. Elige cómo llega AnythingMCP a ella:',
    optionsLabel: 'Cómo llegar a la carpeta',
    optionLabels: { s3: 'Almacenamiento compatible con S3', local: 'Carpeta de red' },
    optionHints: {
      sftp: 'Servidor Linux o Windows, la mayoría de los NAS',
      ftps: 'FTP con cifrado TLS',
      ftp: 'Sin cifrar, solo si no funciona nada más',
      webdav: 'Cualquier recurso compartido WebDAV',
      local: 'Una carpeta montada en este servidor',
    },
    step1: 'Introduce la dirección del servidor y una cuenta de solo lectura, y prueba la conexión.',
    step2: 'Elige las carpetas y los tipos de archivo en los que buscar, y mira cuántos archivos son.',
    step3: 'Revisa la descripción que lee {client} y activa: empieza la primera sincronización.',
    body: 'Lleva unos cinco minutos. Las contraseñas y las claves se introducen en la página siguiente, nunca en el chat. Cuando la carpeta esté activa, vuelves aquí y sigues hacia {client}.',
    skip: 'Omitir por ahora y continuar en {client}',
    doneHeading: 'Vuelve al chat para terminar',
    done1:
      'Mientras tanto, la solicitud de conexión del chat ha caducado. La carpeta que conectaste está guardada y su primera sincronización está en marcha.',
    done2: 'Vuelve al chat y conecta el plugin de nuevo. Ahora tarda unos segundos.',
  },
};

const ZH: EdgePageTexts = {
  closed: {
    heading: '此连接请求已失效',
    what: '连接请求的有效期为 30 分钟，且只能使用一次。',
    next: '<strong>请返回你的 AI 助手。</strong>如果那里没有显示 AnythingMCP 已连接，请再次点击<strong>连接</strong>。',
    dashboardLead: '想找控制台？',
    dashboardLink: '打开 AnythingMCP',
  },
  rateLimit: {
    heading: '尝试次数过多',
    body: '请等待一分钟后再试。你的连接请求会保持 30 分钟有效。',
    back: '返回登录页面',
  },
  cancelled: {
    heading: '请求已取消',
    body: '授权请求已被拒绝，未授予任何访问权限。你可以放心关闭此窗口。',
  },
  fileSearch: {
    heading: '为 {client} 连接一个文件夹',
    sub: '连接文件夹后，{client} 就可以搜索你文件服务器上的文档。请选择 AnythingMCP 访问它的方式：',
    optionsLabel: '访问文件夹的方式',
    optionLabels: { s3: 'S3 兼容存储', local: '网络文件夹' },
    optionHints: {
      sftp: 'Linux 或 Windows 服务器，以及大多数 NAS',
      ftps: '带 TLS 加密的 FTP',
      ftp: '未加密，仅在别无选择时使用',
      webdav: '任意 WebDAV 共享',
      local: '挂载到此服务器的文件夹',
    },
    step1: '输入服务器地址和一个只读账户，并测试连接。',
    step2: '选择要搜索的文件夹和文件类型，并查看共有多少文件。',
    step3: '检查 {client} 读取的描述，然后启用：首次同步随即开始。',
    body: '大约需要五分钟。密码和密钥在下一页填写，绝不会在对话中输入。文件夹启用后，你会回到这里，然后继续前往 {client}。',
    skip: '暂时跳过，继续前往 {client}',
    doneHeading: '请返回对话完成操作',
    done1: '在此期间，来自对话的连接请求已超时。你连接的文件夹已保存，首次同步正在进行。',
    done2: '请返回对话，重新连接该插件。现在只需几秒钟。',
  },
};

const JA: EdgePageTexts = {
  closed: {
    heading: 'この接続リクエストは、すでに終了しています',
    what: '接続リクエストの有効期間は 30 分で、使用できるのは 1 回です。',
    next: '<strong>AI アシスタントに戻ってください。</strong>そこで AnythingMCP が接続済みと表示されていない場合は、もう一度<strong>接続</strong>を押してください。',
    dashboardLead: 'ダッシュボードをお探しですか？',
    dashboardLink: 'AnythingMCP を開く',
  },
  rateLimit: {
    heading: '試行回数が多すぎます',
    body: '1 分ほど待ってから、もう一度お試しください。接続リクエストは 30 分間有効です。',
    back: 'ログインページに戻る',
  },
  cancelled: {
    heading: 'リクエストをキャンセルしました',
    body: '認可リクエストは拒否されました。アクセス権は付与されていません。このウィンドウは閉じてかまいません。',
  },
  fileSearch: {
    heading: '{client} 用のフォルダを接続',
    sub: 'フォルダを接続すると、{client} がファイルサーバー上のドキュメントを検索できるようになります。AnythingMCP からの接続方法を選んでください。',
    optionsLabel: 'フォルダへの接続方法',
    optionLabels: { s3: 'S3 互換ストレージ', local: 'ネットワークフォルダ' },
    optionHints: {
      sftp: 'Linux / Windows サーバー、ほとんどの NAS',
      ftps: 'TLS で暗号化された FTP',
      ftp: '暗号化なし。ほかに方法がない場合のみ',
      webdav: '任意の WebDAV 共有',
      local: 'このサーバーにマウントされたフォルダ',
    },
    step1: 'サーバーのアドレスと読み取り専用アカウントを入力し、接続をテストします。',
    step2: '検索するフォルダとファイルの種類を選び、対象のファイル数を確認します。',
    step3: '{client} が読む説明文を確認して有効化すると、最初の同期が始まります。',
    body: '所要時間は 5 分ほどです。パスワードやキーは次のページで入力し、チャットには入力しません。フォルダが有効になると、このページに戻り、{client} に進みます。',
    skip: '今はスキップして {client} に進む',
    doneHeading: 'チャットに戻って完了してください',
    done1:
      'その間に、チャットからの接続リクエストがタイムアウトしました。接続したフォルダは保存されており、最初の同期が実行中です。',
    done2: 'チャットに戻り、プラグインをもう一度接続してください。今度は数秒で完了します。',
  },
};

const RU: EdgePageTexts = {
  closed: {
    heading: 'Этот запрос на подключение больше не активен',
    what: 'Запрос на подключение действует 30 минут и срабатывает один раз.',
    next: '<strong>Вернитесь в ваш ИИ-ассистент.</strong> Если AnythingMCP там не отображается как подключённый, снова нажмите <strong>Подключить</strong>.',
    dashboardLead: 'Ищете панель управления?',
    dashboardLink: 'Открыть AnythingMCP',
  },
  rateLimit: {
    heading: 'Слишком много попыток',
    body: 'Подождите минуту и попробуйте ещё раз. Ваш запрос на подключение действует 30 минут.',
    back: 'Вернуться на страницу входа',
  },
  cancelled: {
    heading: 'Запрос отменён',
    body: 'Запрос на авторизацию отклонён. Доступ не предоставлен. Это окно можно закрыть.',
  },
  fileSearch: {
    heading: 'Подключите папку для {client}',
    sub: '{client} сможет искать по документам на вашем файловом сервере, когда папка будет подключена. Выберите, как AnythingMCP получит к ней доступ:',
    optionsLabel: 'Способ доступа к папке',
    optionLabels: { s3: 'S3-совместимое хранилище', local: 'Сетевая папка' },
    optionHints: {
      sftp: 'Сервер Linux или Windows, большинство NAS',
      ftps: 'FTP с шифрованием TLS',
      ftp: 'Без шифрования, только если ничто другое не работает',
      webdav: 'Любой ресурс WebDAV',
      local: 'Папка, смонтированная на этом сервере',
    },
    step1: 'Введите адрес сервера и учётную запись только для чтения, затем проверьте подключение.',
    step2: 'Выберите папки и типы файлов для поиска и посмотрите, сколько это файлов.',
    step3: 'Проверьте описание, которое читает {client}, и активируйте: начнётся первая синхронизация.',
    body: 'Это займёт около пяти минут. Пароли и ключи вводятся на следующей странице, никогда в чате. Когда папка станет активной, вы вернётесь сюда и затем в {client}.',
    skip: 'Пока пропустить и продолжить в {client}',
    doneHeading: 'Вернитесь в чат, чтобы закончить',
    done1:
      'Тем временем запрос на подключение из чата истёк. Подключённая вами папка сохранена, и её первая синхронизация уже идёт.',
    done2: 'Вернитесь в чат и подключите плагин ещё раз. Теперь это займёт несколько секунд.',
  },
};

export const EDGE_PAGE_TEXTS: Record<PageLanguage, EdgePageTexts> = {
  en: EN,
  de: DE,
  it: IT,
  es: ES,
  zh: ZH,
  ja: JA,
  ru: RU,
};
export const edgePageTexts = textsFor(EDGE_PAGE_TEXTS);
