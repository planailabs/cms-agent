export type LocaleKey = 'en' | 'de';

export interface StreamConfig {
  initialDelayMs: number;
  chunkSize: number;
  intervalMs: number;
}

export interface ChatModeLocale {
  heading: string;
  /** 1-2 line hint under the empty-state heading (what the agent can do now) */
  emptyHint: string;
  /** Example prompts shown as chips in the empty state; click fills the composer */
  examplePrompts: string[];
  placeholder: string;
  cancelLabel: string;
  configuringLabel: string;
  greeting: string;
}

export interface LocaleContent {
  languageNativeName: string;
  locale: string;
  navigation: {
    themeToggle: {
      label: string;
      tooltip: string;
    };
    languageMenu: {
      label: string;
      tooltip: string;
    };
    settingsLabel: string;
    signOutLabel: string;
  };
  composer: {
    submitLabel: string;
    maxCharacters: number;
    limitReachedLabel: string;
  };
  chat: {
    /** Scripted intro shown by the streaming controller when no override is given */
    intro: {
      text: string;
      stream: StreamConfig;
    };
  };
  settings: {
    title: string;
    sections: {
      profile: {
        title: string;
        fields: {
          name: string;
        };
      };
    };
  };
  chatMode: ChatModeLocale;
}

const defaultStream: StreamConfig = {
  initialDelayMs: 480,
  chunkSize: 3,
  intervalMs: 28,
};

const en: LocaleContent = {
  languageNativeName: 'English',
  locale: 'en-US',
  navigation: {
    themeToggle: {
      label: 'Theme',
      tooltip: 'Switch design',
    },
    languageMenu: {
      label: 'Language',
      tooltip: 'Switch language',
    },
    settingsLabel: 'Settings',
    signOutLabel: 'Sign out',
  },
  composer: {
    submitLabel: 'Send',
    maxCharacters: 1024,
    limitReachedLabel: 'You’ve reached the {{max}} character limit.',
  },
  chat: {
    intro: {
      text: 'Hi! Tell me what you’d like to change on your site.',
      stream: defaultStream,
    },
  },
  settings: {
    title: 'Settings',
    sections: {
      profile: {
        title: 'Profile',
        fields: {
          name: 'Your name',
        },
      },
    },
  },
  chatMode: {
    heading: 'What should change on your site?',
    emptyHint:
      'Describe a change and the agent drafts a plan for you to approve before anything is touched.',
    examplePrompts: [
      'Update the hero text on the start page',
      'Add a blog post about our latest release',
      'Tweak the footer layout and links',
    ],
    placeholder: 'Update the hero text, add a blog post, tweak the layout...',
    cancelLabel: 'Skip',
    configuringLabel: 'Working…',
    greeting: '',
  },
};

const de: LocaleContent = {
  languageNativeName: 'Deutsch',
  locale: 'de-DE',
  navigation: {
    themeToggle: {
      label: 'Theme',
      tooltip: 'Design wechseln',
    },
    languageMenu: {
      label: 'Sprache',
      tooltip: 'Sprache wechseln',
    },
    settingsLabel: 'Einstellungen',
    signOutLabel: 'Abmelden',
  },
  composer: {
    submitLabel: 'Senden',
    maxCharacters: 1024,
    limitReachedLabel: 'Die maximale Zeichenanzahl ({{max}}) ist erreicht.',
  },
  chat: {
    intro: {
      text: 'Hallo! Erzähl mir, was du an deiner Website ändern möchtest.',
      stream: defaultStream,
    },
  },
  settings: {
    title: 'Einstellungen',
    sections: {
      profile: {
        title: 'Profil',
        fields: {
          name: 'Dein Name',
        },
      },
    },
  },
  chatMode: {
    heading: 'Was soll sich auf deiner Website ändern?',
    emptyHint:
      'Beschreibe eine Änderung — der Agent entwirft zuerst einen Plan, den du freigibst, bevor etwas passiert.',
    examplePrompts: [
      'Hero-Text auf der Startseite aktualisieren',
      'Blogpost über unser neuestes Release hinzufügen',
      'Footer-Layout und Links anpassen',
    ],
    placeholder: 'Hero-Text aktualisieren, Blogpost hinzufügen, Layout anpassen...',
    cancelLabel: 'Überspringen',
    configuringLabel: 'Arbeite…',
    greeting: '',
  },
};

export const locales: Record<LocaleKey, LocaleContent> = {
  en,
  de,
};

export const supportedLocales: LocaleKey[] = Object.keys(
  locales,
) as LocaleKey[];

export const defaultLocale: LocaleKey = 'en';
