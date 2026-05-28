'use client';

import { useEffect } from 'react';
import 'vanilla-cookieconsent/dist/cookieconsent.css';
import * as CookieConsent from 'vanilla-cookieconsent';

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
    dataLayer?: unknown[];
  }
}

// Mirrors the banner on anythingmcp.com. When `cookieDomain` is
// '.anythingmcp.com', the consent cookie is shared between the
// marketing site and cloud.anythingmcp.com so users only see the
// banner once across both properties.

function updateGtagConsent() {
  if (typeof window === 'undefined' || typeof window.gtag !== 'function') return;

  window.gtag('consent', 'update', {
    analytics_storage: CookieConsent.acceptedCategory('analytics') ? 'granted' : 'denied',
    ad_storage: CookieConsent.acceptedCategory('marketing') ? 'granted' : 'denied',
    ad_user_data: CookieConsent.acceptedCategory('marketing') ? 'granted' : 'denied',
    ad_personalization: CookieConsent.acceptedCategory('marketing') ? 'granted' : 'denied',
    functionality_storage: CookieConsent.acceptedCategory('functionality') ? 'granted' : 'denied',
    personalization_storage: CookieConsent.acceptedCategory('functionality') ? 'granted' : 'denied',
  });
}

function policyLink(locale: string, label: string) {
  const prefix = locale === 'en' ? '' : `/${locale}`;
  return `<a href="https://anythingmcp.com${prefix}/cookie-policy" target="_blank" rel="noopener">${label}</a>`;
}

const translations: Record<string, CookieConsent.Translation> = {
  en: {
    consentModal: {
      title: 'We use cookies',
      description:
        'We use cookies to improve your experience and to analyze site traffic. You can choose which categories to allow.',
      acceptAllBtn: 'Accept all',
      acceptNecessaryBtn: 'Reject all',
      showPreferencesBtn: 'Manage preferences',
    },
    preferencesModal: {
      title: 'Cookie Preferences',
      acceptAllBtn: 'Accept all',
      acceptNecessaryBtn: 'Reject all',
      savePreferencesBtn: 'Save preferences',
      closeIconLabel: 'Close',
      sections: [
        {
          title: 'Cookie usage',
          description:
            'We use cookies to ensure the basic functionality of the website, to enhance your experience, and for analytics and marketing purposes. You can manage your preferences for each category.',
        },
        {
          title: 'Essential cookies',
          description:
            'These cookies are necessary for the website to function and cannot be switched off.',
          linkedCategory: 'necessary',
        },
        {
          title: 'Analytics cookies',
          description:
            'These cookies help us understand how visitors interact with the website by collecting anonymous information.',
          linkedCategory: 'analytics',
        },
        {
          title: 'Functionality cookies',
          description:
            'These cookies enable personalized features and remember your preferences.',
          linkedCategory: 'functionality',
        },
        {
          title: 'Marketing cookies',
          description:
            'These cookies are used to track visitors across websites and display relevant advertisements.',
          linkedCategory: 'marketing',
        },
        {
          title: 'More information',
          description: `For any questions about our cookie policy, please ${policyLink('en', 'read our cookie policy')}.`,
        },
      ],
    },
  },
  de: {
    consentModal: {
      title: 'Wir verwenden Cookies',
      description:
        'Wir verwenden Cookies, um Ihre Erfahrung zu verbessern und den Website-Traffic zu analysieren. Sie können wählen, welche Kategorien Sie zulassen möchten.',
      acceptAllBtn: 'Alle akzeptieren',
      acceptNecessaryBtn: 'Alle ablehnen',
      showPreferencesBtn: 'Einstellungen verwalten',
    },
    preferencesModal: {
      title: 'Cookie-Einstellungen',
      acceptAllBtn: 'Alle akzeptieren',
      acceptNecessaryBtn: 'Alle ablehnen',
      savePreferencesBtn: 'Einstellungen speichern',
      closeIconLabel: 'Schließen',
      sections: [
        {
          title: 'Cookie-Nutzung',
          description:
            'Wir verwenden Cookies, um die grundlegende Funktionalität der Website sicherzustellen, Ihre Erfahrung zu verbessern sowie für Analyse- und Marketingzwecke. Sie können Ihre Einstellungen für jede Kategorie verwalten.',
        },
        {
          title: 'Essenzielle Cookies',
          description:
            'Diese Cookies sind für die Funktion der Website notwendig und können nicht deaktiviert werden.',
          linkedCategory: 'necessary',
        },
        {
          title: 'Analyse-Cookies',
          description:
            'Diese Cookies helfen uns zu verstehen, wie Besucher mit der Website interagieren, indem sie anonyme Informationen sammeln.',
          linkedCategory: 'analytics',
        },
        {
          title: 'Funktionalitäts-Cookies',
          description:
            'Diese Cookies ermöglichen personalisierte Funktionen und merken sich Ihre Einstellungen.',
          linkedCategory: 'functionality',
        },
        {
          title: 'Marketing-Cookies',
          description:
            'Diese Cookies werden verwendet, um Besucher über Websites hinweg zu verfolgen und relevante Werbung anzuzeigen.',
          linkedCategory: 'marketing',
        },
        {
          title: 'Weitere Informationen',
          description: `Bei Fragen zu unserer Cookie-Richtlinie lesen Sie bitte ${policyLink('de', 'unsere Cookie-Richtlinie')}.`,
        },
      ],
    },
  },
  it: {
    consentModal: {
      title: 'Utilizziamo i cookie',
      description:
        'Utilizziamo i cookie per migliorare la tua esperienza e analizzare il traffico del sito. Puoi scegliere quali categorie consentire.',
      acceptAllBtn: 'Accetta tutti',
      acceptNecessaryBtn: 'Rifiuta tutti',
      showPreferencesBtn: 'Gestisci preferenze',
    },
    preferencesModal: {
      title: 'Preferenze Cookie',
      acceptAllBtn: 'Accetta tutti',
      acceptNecessaryBtn: 'Rifiuta tutti',
      savePreferencesBtn: 'Salva preferenze',
      closeIconLabel: 'Chiudi',
      sections: [
        {
          title: 'Utilizzo dei cookie',
          description:
            'Utilizziamo i cookie per garantire le funzionalità di base del sito, per migliorare la tua esperienza e per scopi di analisi e marketing. Puoi gestire le tue preferenze per ogni categoria.',
        },
        {
          title: 'Cookie essenziali',
          description:
            'Questi cookie sono necessari per il funzionamento del sito e non possono essere disattivati.',
          linkedCategory: 'necessary',
        },
        {
          title: 'Cookie analitici',
          description:
            'Questi cookie ci aiutano a capire come i visitatori interagiscono con il sito raccogliendo informazioni anonime.',
          linkedCategory: 'analytics',
        },
        {
          title: 'Cookie funzionali',
          description:
            'Questi cookie abilitano funzionalità personalizzate e ricordano le tue preferenze.',
          linkedCategory: 'functionality',
        },
        {
          title: 'Cookie di marketing',
          description:
            'Questi cookie vengono utilizzati per tracciare i visitatori sui siti web e mostrare pubblicità pertinenti.',
          linkedCategory: 'marketing',
        },
        {
          title: 'Maggiori informazioni',
          description: `Per qualsiasi domanda sulla nostra politica dei cookie, ${policyLink('it', 'leggi la nostra informativa sui cookie')}.`,
        },
      ],
    },
  },
  es: {
    consentModal: {
      title: 'Usamos cookies',
      description:
        'Usamos cookies para mejorar tu experiencia y analizar el tráfico del sitio. Puedes elegir qué categorías permitir.',
      acceptAllBtn: 'Aceptar todas',
      acceptNecessaryBtn: 'Rechazar todas',
      showPreferencesBtn: 'Gestionar preferencias',
    },
    preferencesModal: {
      title: 'Preferencias de cookies',
      acceptAllBtn: 'Aceptar todas',
      acceptNecessaryBtn: 'Rechazar todas',
      savePreferencesBtn: 'Guardar preferencias',
      closeIconLabel: 'Cerrar',
      sections: [
        {
          title: 'Uso de cookies',
          description:
            'Usamos cookies para garantizar la funcionalidad básica del sitio web, mejorar tu experiencia y con fines de análisis y marketing. Puedes gestionar tus preferencias para cada categoría.',
        },
        {
          title: 'Cookies esenciales',
          description:
            'Estas cookies son necesarias para el funcionamiento del sitio web y no se pueden desactivar.',
          linkedCategory: 'necessary',
        },
        {
          title: 'Cookies analíticas',
          description:
            'Estas cookies nos ayudan a entender cómo los visitantes interactúan con el sitio web recopilando información anónima.',
          linkedCategory: 'analytics',
        },
        {
          title: 'Cookies funcionales',
          description:
            'Estas cookies permiten funciones personalizadas y recuerdan tus preferencias.',
          linkedCategory: 'functionality',
        },
        {
          title: 'Cookies de marketing',
          description:
            'Estas cookies se utilizan para rastrear visitantes en sitios web y mostrar anuncios relevantes.',
          linkedCategory: 'marketing',
        },
        {
          title: 'Más información',
          description: `Si tienes preguntas sobre nuestra política de cookies, ${policyLink('es', 'lee nuestra política de cookies')}.`,
        },
      ],
    },
  },
  zh: {
    consentModal: {
      title: '我们使用 Cookie',
      description: '我们使用 Cookie 来改善您的体验并分析网站流量。您可以选择允许哪些类别。',
      acceptAllBtn: '全部接受',
      acceptNecessaryBtn: '全部拒绝',
      showPreferencesBtn: '管理偏好设置',
    },
    preferencesModal: {
      title: 'Cookie 偏好设置',
      acceptAllBtn: '全部接受',
      acceptNecessaryBtn: '全部拒绝',
      savePreferencesBtn: '保存偏好设置',
      closeIconLabel: '关闭',
      sections: [
        {
          title: 'Cookie 使用说明',
          description: '我们使用 Cookie 来确保网站的基本功能、改善您的体验，以及用于分析和营销目的。您可以管理每个类别的偏好设置。',
        },
        {
          title: '必要 Cookie',
          description: '这些 Cookie 是网站运行所必需的，无法关闭。',
          linkedCategory: 'necessary',
        },
        {
          title: '分析 Cookie',
          description: '这些 Cookie 通过收集匿名信息帮助我们了解访问者如何与网站互动。',
          linkedCategory: 'analytics',
        },
        {
          title: '功能 Cookie',
          description: '这些 Cookie 启用个性化功能并记住您的偏好设置。',
          linkedCategory: 'functionality',
        },
        {
          title: '营销 Cookie',
          description: '这些 Cookie 用于跨网站跟踪访问者并展示相关广告。',
          linkedCategory: 'marketing',
        },
        {
          title: '更多信息',
          description: `如果您对我们的 Cookie 政策有任何疑问，请${policyLink('zh', '阅读我们的 Cookie 政策')}。`,
        },
      ],
    },
  },
  ja: {
    consentModal: {
      title: 'Cookie を使用しています',
      description:
        '当サイトでは、エクスペリエンスの向上とサイトトラフィックの分析のために Cookie を使用しています。許可するカテゴリを選択できます。',
      acceptAllBtn: 'すべて許可',
      acceptNecessaryBtn: 'すべて拒否',
      showPreferencesBtn: '設定を管理',
    },
    preferencesModal: {
      title: 'Cookie 設定',
      acceptAllBtn: 'すべて許可',
      acceptNecessaryBtn: 'すべて拒否',
      savePreferencesBtn: '設定を保存',
      closeIconLabel: '閉じる',
      sections: [
        {
          title: 'Cookie の使用について',
          description:
            '当サイトでは、基本機能の確保、エクスペリエンスの向上、分析およびマーケティング目的で Cookie を使用しています。各カテゴリの設定を管理できます。',
        },
        {
          title: '必須 Cookie',
          description: 'これらの Cookie はウェブサイトの機能に必要であり、オフにすることはできません。',
          linkedCategory: 'necessary',
        },
        {
          title: '分析 Cookie',
          description:
            'これらの Cookie は、匿名情報を収集することで、訪問者がウェブサイトとどのようにやり取りしているかを理解するのに役立ちます。',
          linkedCategory: 'analytics',
        },
        {
          title: '機能 Cookie',
          description: 'これらの Cookie はパーソナライズされた機能を有効にし、お客様の設定を記憶します。',
          linkedCategory: 'functionality',
        },
        {
          title: 'マーケティング Cookie',
          description: 'これらの Cookie は、ウェブサイト間で訪問者を追跡し、関連性の高い広告を表示するために使用されます。',
          linkedCategory: 'marketing',
        },
        {
          title: '詳細情報',
          description: `Cookie ポリシーについてご質問がある場合は、${policyLink('ja', 'Cookie ポリシー')}をご覧ください。`,
        },
      ],
    },
  },
  ru: {
    consentModal: {
      title: 'Мы используем файлы cookie',
      description:
        'Мы используем файлы cookie для улучшения вашего опыта и анализа трафика сайта. Вы можете выбрать, какие категории разрешить.',
      acceptAllBtn: 'Принять все',
      acceptNecessaryBtn: 'Отклонить все',
      showPreferencesBtn: 'Управление настройками',
    },
    preferencesModal: {
      title: 'Настройки cookie',
      acceptAllBtn: 'Принять все',
      acceptNecessaryBtn: 'Отклонить все',
      savePreferencesBtn: 'Сохранить настройки',
      closeIconLabel: 'Закрыть',
      sections: [
        {
          title: 'Использование cookie',
          description:
            'Мы используем файлы cookie для обеспечения базовой функциональности сайта, улучшения вашего опыта, а также в аналитических и маркетинговых целях. Вы можете управлять настройками для каждой категории.',
        },
        {
          title: 'Основные cookie',
          description: 'Эти файлы cookie необходимы для работы сайта и не могут быть отключены.',
          linkedCategory: 'necessary',
        },
        {
          title: 'Аналитические cookie',
          description:
            'Эти файлы cookie помогают нам понять, как посетители взаимодействуют с сайтом, собирая анонимную информацию.',
          linkedCategory: 'analytics',
        },
        {
          title: 'Функциональные cookie',
          description: 'Эти файлы cookie обеспечивают персонализированные функции и запоминают ваши настройки.',
          linkedCategory: 'functionality',
        },
        {
          title: 'Маркетинговые cookie',
          description:
            'Эти файлы cookie используются для отслеживания посетителей на сайтах и отображения релевантной рекламы.',
          linkedCategory: 'marketing',
        },
        {
          title: 'Дополнительная информация',
          description: `По вопросам о нашей политике cookie, пожалуйста, ${policyLink('ru', 'ознакомьтесь с нашей политикой cookie')}.`,
        },
      ],
    },
  },
};

export function CookieConsentBanner({ cookieDomain }: { cookieDomain?: string }) {
  useEffect(() => {
    CookieConsent.run({
      guiOptions: {
        consentModal: { layout: 'box inline', position: 'bottom left' },
        preferencesModal: { layout: 'box' },
      },

      cookie: {
        name: 'cc_cookie',
        domain: cookieDomain || undefined,
        path: '/',
        sameSite: 'Lax',
        expiresAfterDays: 182,
      },

      categories: {
        necessary: { enabled: true, readOnly: true },
        analytics: {
          autoClear: {
            cookies: [{ name: /^_ga/ }, { name: '_gid' }, { name: /^_gat/ }],
          },
        },
        functionality: {},
        marketing: {
          autoClear: {
            cookies: [{ name: /^_gcl/ }, { name: '_fbp' }, { name: /^_fbc/ }],
          },
        },
      },

      language: {
        default: 'en',
        autoDetect: 'browser',
        translations,
      },

      onFirstConsent: updateGtagConsent,
      onConsent: updateGtagConsent,
      onChange: updateGtagConsent,
    });
  }, [cookieDomain]);

  return null;
}

// Convenience to open the preferences modal from a footer link.
export function openCookiePreferences() {
  CookieConsent.showPreferences();
}
