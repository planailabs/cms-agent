/**
 * Catalog: chat transcript UI (bubbles, cards, phase labels). Chat chrome
 * that predates this module lives in src/components/chat/content/locales.ts.
 */
import type { AreaCatalogs } from './types';

export const chatCatalogs: AreaCatalogs = {
  en: {
    'chat.automatismHead': 'Automatism',
    'chat.attach.add': 'Attach a file',
    'chat.attach.remove': 'Remove attachment',
    'chat.toolRunning': 'running…',
    'chat.compaction.working': 'Compacting…',
    'chat.compaction.title': 'Earlier conversation compacted',
    // Plan approval card
    'chat.plan.title': 'Proposed plan',
    'chat.plan.view': 'View the plan in fullscreen',
    'chat.plan.viewButton': 'Plan',
    'chat.plan.none': 'No plan has been proposed in this chat yet.',
    'chat.plan.risk': 'risk: {risk}',
    'chat.plan.steps': 'Steps',
    'chat.plan.files': 'Files',
    'chat.plan.path': 'Path',
    'chat.plan.action': 'Action',
    'chat.plan.reason': 'Reason',
    'chat.plan.pages': 'Pages',
    'chat.plan.openQuestions': 'Open questions',
    'chat.plan.approve': 'Approve plan',
    'chat.plan.requestChanges': 'Request changes',
    // Execution cards
    'chat.execution.finishedTitle': 'Implementation finished',
    'chat.execution.createPreview': 'Create preview',
    'chat.execution.notYet': 'Not yet — keep chatting',
    'chat.execution.revertedTitle': '{sha} reverted',
    'chat.execution.undoneBy': 'Undone by {by} (revert {sha})',
    'chat.execution.committedTitle': 'Committed {sha}',
    'chat.execution.undoing': 'Undoing…',
    'chat.execution.undo': 'Undo',
    // Publish progress card
    'chat.publish.publishing': 'Publishing {sha}…',
    'chat.publish.published': 'Published {sha} ✓',
    'chat.publish.viewDeployment': 'View deployment ↗',
    'chat.publish.failedTitle': 'Publish failed',
    'chat.publish.retry': 'Retry',
    // Context chip
    'chat.context.remove': 'Remove context',
    // Errors / interrupted turn
    'chat.error.generic': 'Something went wrong',
    'chat.error.network': 'Network error — could not continue the session.',
    'chat.error.continueFailed': 'Continue failed ({status})',
    'chat.error.retry': 'Retry',
    'chat.continue.interrupted': 'This session was interrupted before the last turn finished.',
    'chat.continue.button': 'Continue',
    // needs_human_attention prompt
    'chat.attention.head': 'Needs human attention',
    'chat.attention.done': 'Done',
    // Automatism input gate
    'chat.automatism.gate': 'Automatism running ({step}) — chat opens when it pauses or finishes.',
    // Archived chats take no input
    'chat.archived.note': 'This chat is archived — it can no longer receive messages.',
    // Sidebar chrome
    'chat.sidebar.resize': 'Resize chat sidebar',
    'chat.sidebar.expand': 'Expand chat sidebar',
    'chat.sidebar.collapse': 'Collapse chat sidebar',
    // Header
    'chat.header.dashboard': 'Dashboard',
    // Settings overlay
    'chat.settings.notSignedIn': 'Not signed in',
    'chat.settings.closeOverlay': 'Close overlay',
    'chat.settings.close': 'Close',
    'chat.settings.mode.title': 'Conversation style',
    'chat.settings.mode.description':
      'Choose whether the assistant focuses only on website outcomes or also shows implementation details.',
    'chat.settings.mode.label': 'Mode',
    'chat.settings.mode.default': 'Default ({mode})',
    'chat.settings.mode.nonTechnical': 'Non-technical',
    'chat.settings.mode.technical': 'Technical',
  },
  de: {
    'chat.automatismHead': 'Automatismus',
    'chat.attach.add': 'Datei anhängen',
    'chat.attach.remove': 'Anhang entfernen',
    'chat.toolRunning': 'läuft…',
    'chat.compaction.working': 'Kontext wird komprimiert…',
    'chat.compaction.title': 'Früherer Gesprächsverlauf komprimiert',
    // Plan approval card
    'chat.plan.title': 'Vorgeschlagener Plan',
    'chat.plan.view': 'Plan im Vollbild ansehen',
    'chat.plan.viewButton': 'Plan',
    'chat.plan.none': 'In diesem Chat wurde noch kein Plan vorgeschlagen.',
    'chat.plan.risk': 'Risiko: {risk}',
    'chat.plan.steps': 'Schritte',
    'chat.plan.files': 'Dateien',
    'chat.plan.path': 'Pfad',
    'chat.plan.action': 'Aktion',
    'chat.plan.reason': 'Grund',
    'chat.plan.pages': 'Seiten',
    'chat.plan.openQuestions': 'Offene Fragen',
    'chat.plan.approve': 'Plan freigeben',
    'chat.plan.requestChanges': 'Änderungen anfordern',
    // Execution cards
    'chat.execution.finishedTitle': 'Umsetzung abgeschlossen',
    'chat.execution.createPreview': 'Vorschau erstellen',
    'chat.execution.notYet': 'Noch nicht — weiter chatten',
    'chat.execution.revertedTitle': '{sha} rückgängig gemacht',
    'chat.execution.undoneBy': 'Rückgängig gemacht von {by} (Revert {sha})',
    'chat.execution.committedTitle': 'Commit {sha} erstellt',
    'chat.execution.undoing': 'Wird rückgängig gemacht…',
    'chat.execution.undo': 'Rückgängig machen',
    // Publish progress card
    'chat.publish.publishing': 'Veröffentliche {sha}…',
    'chat.publish.published': '{sha} veröffentlicht ✓',
    'chat.publish.viewDeployment': 'Deployment ansehen ↗',
    'chat.publish.failedTitle': 'Veröffentlichung fehlgeschlagen',
    'chat.publish.retry': 'Erneut versuchen',
    // Context chip
    'chat.context.remove': 'Kontext entfernen',
    // Errors / interrupted turn
    'chat.error.generic': 'Etwas ist schiefgelaufen',
    'chat.error.network': 'Netzwerkfehler — die Session konnte nicht fortgesetzt werden.',
    'chat.error.continueFailed': 'Fortsetzen fehlgeschlagen ({status})',
    'chat.error.retry': 'Erneut versuchen',
    'chat.continue.interrupted': 'Diese Session wurde unterbrochen, bevor der letzte Schritt abgeschlossen war.',
    'chat.continue.button': 'Fortsetzen',
    // needs_human_attention prompt
    'chat.attention.head': 'Braucht menschliche Aufmerksamkeit',
    'chat.attention.done': 'Erledigt',
    // Automatism input gate
    'chat.automatism.gate': 'Automatismus läuft ({step}) — der Chat öffnet sich, sobald er pausiert oder fertig ist.',
    // Archivierte Chats nehmen keine Eingaben an
    'chat.archived.note': 'Dieser Chat ist archiviert — er kann keine Nachrichten mehr empfangen.',
    // Sidebar chrome
    'chat.sidebar.resize': 'Größe der Chat-Seitenleiste ändern',
    'chat.sidebar.expand': 'Chat-Seitenleiste ausklappen',
    'chat.sidebar.collapse': 'Chat-Seitenleiste einklappen',
    // Header
    'chat.header.dashboard': 'Dashboard',
    // Settings overlay
    'chat.settings.notSignedIn': 'Nicht angemeldet',
    'chat.settings.closeOverlay': 'Overlay schließen',
    'chat.settings.close': 'Schließen',
    'chat.settings.mode.title': 'Gesprächsstil',
    'chat.settings.mode.description':
      'Wähle, ob der Assistent nur die Auswirkungen auf die Website oder auch technische Details zeigt.',
    'chat.settings.mode.label': 'Modus',
    'chat.settings.mode.default': 'Standard ({mode})',
    'chat.settings.mode.nonTechnical': 'Nicht technisch',
    'chat.settings.mode.technical': 'Technisch',
  },
};
