/**
 * Catalog: workspace UI (sidebar, preview pane, diff viewer, publish card,
 * archive, modals). Keys are namespaced `workspace.*`.
 */
import type { AreaCatalogs } from './types';

export const workspaceCatalogs: AreaCatalogs = {
  en: {
    // ── sidebar: branch switcher + chat list ──
    'workspace.sidebar.phaseShort.plan': 'plan',
    'workspace.sidebar.phaseShort.execute': 'exec',
    'workspace.sidebar.phaseShort.preview': 'prev',
    'workspace.sidebar.phaseShort.published': 'pub',
    'workspace.sidebar.kind.deployment': 'deploy',
    'workspace.sidebar.kind.deployments': 'deployments',
    'workspace.sidebar.untitledChat': 'Untitled chat',
    'workspace.sidebar.newChatOn': 'New chat on {branch}',
    'workspace.sidebar.newChatButton': '+ chat',
    'workspace.sidebar.noChats': 'No chats yet',
    'workspace.sidebar.newBranch': '+ New branch',
    'workspace.sidebar.archiveTitle': 'Done chats',
    'workspace.sidebar.archiveButton': '🗄 Archive',
    'workspace.sidebar.noBranches': 'No branches yet',

    // ── phase bar (PLAN → EXECUTE → PREVIEW → PUBLISH) + automatism bar ──
    'workspace.phase.plan': 'Plan',
    'workspace.phase.execute': 'Execute',
    'workspace.phase.preview': 'Preview',
    'workspace.phase.published': 'Publish',
    'workspace.phase.pausedInvestigating': 'paused — agent investigating',
    'workspace.phase.paused': 'paused',
    'workspace.phase.failed': 'failed',
    'workspace.phase.resumeTitle': 'Re-run the failed step ({step}) and continue',
    'workspace.phase.resume': '▶ Resume',
    'workspace.phase.syncTitle': 'Rebase this draft onto the latest target branch state',
    'workspace.phase.syncing': '⟳ Syncing…',
    'workspace.phase.sync': '⟳ Sync',
    'workspace.phase.publishSha': 'Publish {sha}',
    'workspace.phase.waitingForCommit': 'Waiting for the reviewed commit',
    'workspace.phase.publishing': 'Publishing…',
    'workspace.phase.publish': 'Publish',
    'workspace.phase.requestChanges': 'Request changes',

    // ── archive modal ──
    'workspace.archive.loadFailed': 'Failed to load the archive ({status})',
    'workspace.archive.loadNetworkError': 'Network error while loading the archive.',
    'workspace.archive.deleteConfirm':
      'Delete "{title}" permanently?\nThis removes the chat, its work branch ({workBranch}), worktree and all data.',
    'workspace.archive.deleteFailed': 'Delete failed ({status})',
    'workspace.archive.deleteNetworkError': 'Network error while deleting.',
    'workspace.archive.kind.workflow': 'chat',
    'workspace.archive.kind.deployment': 'deploy',
    'workspace.archive.kind.deployments': 'deployments',
    'workspace.archive.archivedAt': 'archived {when}',
    'workspace.archive.deleting': 'Deleting…',
    'workspace.archive.delete': 'Delete',
    'workspace.archive.loading': 'Loading…',
    'workspace.archive.empty':
      'No archived chats yet — chats land here when they are done (published / deployed).',
    'workspace.archive.heading': 'Archive',
    'workspace.archive.closeLabel': 'Close archive',
    'workspace.archive.close': '✕ Close',

    // ── publication / automatism status labels (fallback: raw status) ──
    'workspace.status.running': 'running',
    'workspace.status.succeeded': 'succeeded',
    'workspace.status.failed': 'failed',

    // ── preview pane (tabs, toolbar) ──
    'workspace.preview.closeTab': 'Close tab',
    'workspace.preview.newTab': 'New preview tab',
    'workspace.preview.branchTitle': 'Work branch → target branch',
    'workspace.preview.addressTitle': 'Preview route — Enter to navigate',
    'workspace.preview.addressLabel': 'Preview route',
    'workspace.preview.picking': 'Picking… (Esc to cancel)',
    'workspace.preview.elementPicker': '⌖ Element picker',
    'workspace.preview.pickTitle': 'Pick an element in the preview',
    'workspace.preview.browsersTitle': 'Compare how this page renders in different browsers',
    'workspace.preview.browsers': '⧉ Browsers',
    'workspace.preview.openNewTab': 'Open preview in a new tab',
    'workspace.preview.frameTitle': 'Preview of {branch}',

    // ── generic input modal + its callers ──
    'workspace.modal.close': 'Close',
    'workspace.modal.submit': 'Submit',
    'workspace.requestChanges.hint':
      'Describe what should be different — the agent picks it up from there.',
    'workspace.requestChanges.placeholder': 'What should be changed?',
    'workspace.newBranch.title': 'New branch',
    'workspace.newBranch.hint': 'Becomes a git branch and a preview subdomain.',
    'workspace.newBranch.placeholder': 'Branch name (lowercase letters, digits, hyphens)',

    // ── action errors (chat error area) ──
    'workspace.error.requestFailed': 'Request failed ({status})',
    'workspace.error.network': 'Network error — please try again',
    'workspace.error.noReviewedCommit': 'No reviewed commit to publish yet.',
    'workspace.error.branchNameInvalid':
      'Branch name must be DNS-safe (lowercase letters, digits, hyphens).',
    'workspace.error.branchCreateFailed': 'Could not create branch "{name}" (it may already exist).',
    'workspace.error.chatCreateFailed': 'Could not create the chat.',

    // ── diff viewer ──
    'workspace.diff.loadFailed': 'Failed to load changed pages ({status})',
    'workspace.diff.networkError': 'Network error while loading the diff.',
    'workspace.diff.mode.sideBySide': 'Side by side',
    'workspace.diff.mode.highlight': 'Highlight',
    'workspace.diff.mode.onion': 'Onion',
    'workspace.diff.renderingShot': 'Rendering screenshot…',
    'workspace.diff.beforeBranch': 'Before ({branch})',
    'workspace.diff.afterBranch': 'After ({branch})',
    'workspace.diff.beforeRoute': 'Before: {route}',
    'workspace.diff.afterRoute': 'After: {route}',
    'workspace.diff.diffRoute': 'Diff: {route}',
    'workspace.diff.hideOverlay': 'Hide diff overlay',
    'workspace.diff.showOverlay': 'Show diff overlay',
    'workspace.diff.before': 'before',
    'workspace.diff.after': 'after',
    'workspace.diff.loadingPages': 'Loading changed pages…',
    'workspace.diff.retry': 'Retry',
    'workspace.diff.reviewChanges': 'Review changes',
    'workspace.diff.noChangedPages': 'No changed pages were detected on this branch.',
    'workspace.diff.unresolvedNote': 'Changed files without a resolvable page route:',

    // ── cross-browser comparison overlay ──
    'workspace.bc.renderingShot': 'Rendering {name}…',
    'workspace.bc.differences': 'differences',
    'workspace.bc.heading': 'Compare browsers',
    'workspace.bc.vs': 'vs',
    'workspace.bc.hideDiff': 'Hide diff',
    'workspace.bc.showDiff': 'Show diff',
    'workspace.bc.closeTitle': 'Close comparison',
  },
  de: {
    // ── Sidebar: Branch-Umschalter + Chat-Liste ──
    'workspace.sidebar.phaseShort.plan': 'plan',
    'workspace.sidebar.phaseShort.execute': 'ausf.',
    'workspace.sidebar.phaseShort.preview': 'vorschau',
    'workspace.sidebar.phaseShort.published': 'veröff.',
    'workspace.sidebar.kind.deployment': 'Deploy',
    'workspace.sidebar.kind.deployments': 'Deployments',
    'workspace.sidebar.untitledChat': 'Chat ohne Titel',
    'workspace.sidebar.newChatOn': 'Neuer Chat auf {branch}',
    'workspace.sidebar.newChatButton': '+ Chat',
    'workspace.sidebar.noChats': 'Noch keine Chats',
    'workspace.sidebar.newBranch': '+ Neuer Branch',
    'workspace.sidebar.archiveTitle': 'Abgeschlossene Chats',
    'workspace.sidebar.archiveButton': '🗄 Archiv',
    'workspace.sidebar.noBranches': 'Noch keine Branches',

    // ── Phasenleiste + Automatismus-Leiste ──
    'workspace.phase.plan': 'Planen',
    'workspace.phase.execute': 'Umsetzen',
    'workspace.phase.preview': 'Vorschau',
    'workspace.phase.published': 'Veröffentlichen',
    'workspace.phase.pausedInvestigating': 'pausiert — der Agent untersucht das Problem',
    'workspace.phase.paused': 'pausiert',
    'workspace.phase.failed': 'fehlgeschlagen',
    'workspace.phase.resumeTitle':
      'Den fehlgeschlagenen Schritt ({step}) erneut ausführen und fortfahren',
    'workspace.phase.resume': '▶ Fortsetzen',
    'workspace.phase.syncTitle':
      'Diesen Entwurf auf den neuesten Stand des Ziel-Branches rebasen',
    'workspace.phase.syncing': '⟳ Synchronisiere…',
    'workspace.phase.sync': '⟳ Sync',
    'workspace.phase.publishSha': '{sha} veröffentlichen',
    'workspace.phase.waitingForCommit': 'Warte auf den geprüften Commit',
    'workspace.phase.publishing': 'Veröffentliche…',
    'workspace.phase.publish': 'Veröffentlichen',
    'workspace.phase.requestChanges': 'Änderungen anfordern',

    // ── Archiv-Dialog ──
    'workspace.archive.loadFailed': 'Das Archiv konnte nicht geladen werden ({status})',
    'workspace.archive.loadNetworkError': 'Netzwerkfehler beim Laden des Archivs.',
    'workspace.archive.deleteConfirm':
      '"{title}" endgültig löschen?\nDas entfernt den Chat, seinen Arbeits-Branch ({workBranch}), den Worktree und alle Daten.',
    'workspace.archive.deleteFailed': 'Löschen fehlgeschlagen ({status})',
    'workspace.archive.deleteNetworkError': 'Netzwerkfehler beim Löschen.',
    'workspace.archive.kind.workflow': 'Chat',
    'workspace.archive.kind.deployment': 'Deploy',
    'workspace.archive.kind.deployments': 'Deployments',
    'workspace.archive.archivedAt': 'archiviert {when}',
    'workspace.archive.deleting': 'Lösche…',
    'workspace.archive.delete': 'Löschen',
    'workspace.archive.loading': 'Lade…',
    'workspace.archive.empty':
      'Noch keine archivierten Chats — Chats landen hier, sobald sie abgeschlossen sind (veröffentlicht / deployt).',
    'workspace.archive.heading': 'Archiv',
    'workspace.archive.closeLabel': 'Archiv schließen',
    'workspace.archive.close': '✕ Schließen',

    // ── Status-Labels (Fallback: roher Status) ──
    'workspace.status.running': 'läuft',
    'workspace.status.succeeded': 'erfolgreich',
    'workspace.status.failed': 'fehlgeschlagen',

    // ── Vorschau (Tabs, Toolbar) ──
    'workspace.preview.closeTab': 'Tab schließen',
    'workspace.preview.newTab': 'Neuer Vorschau-Tab',
    'workspace.preview.branchTitle': 'Arbeits-Branch → Ziel-Branch',
    'workspace.preview.addressTitle': 'Vorschau-Route — Enter zum Navigieren',
    'workspace.preview.addressLabel': 'Vorschau-Route',
    'workspace.preview.picking': 'Auswahl läuft… (Esc zum Abbrechen)',
    'workspace.preview.elementPicker': '⌖ Element-Picker',
    'workspace.preview.pickTitle': 'Wähle ein Element in der Vorschau aus',
    'workspace.preview.browsersTitle':
      'Vergleiche, wie diese Seite in verschiedenen Browsern dargestellt wird',
    'workspace.preview.browsers': '⧉ Browser',
    'workspace.preview.openNewTab': 'Vorschau in neuem Tab öffnen',
    'workspace.preview.frameTitle': 'Vorschau von {branch}',

    // ── Eingabe-Dialog + Aufrufer ──
    'workspace.modal.close': 'Schließen',
    'workspace.modal.submit': 'Absenden',
    'workspace.requestChanges.hint':
      'Beschreibe, was anders sein soll — der Agent übernimmt ab da.',
    'workspace.requestChanges.placeholder': 'Was soll geändert werden?',
    'workspace.newBranch.title': 'Neuer Branch',
    'workspace.newBranch.hint': 'Wird ein Git-Branch und eine Vorschau-Subdomain.',
    'workspace.newBranch.placeholder': 'Branch-Name (Kleinbuchstaben, Ziffern, Bindestriche)',

    // ── Aktions-Fehler (Chat-Fehlerbereich) ──
    'workspace.error.requestFailed': 'Anfrage fehlgeschlagen ({status})',
    'workspace.error.network': 'Netzwerkfehler — bitte versuch es noch einmal',
    'workspace.error.noReviewedCommit': 'Noch kein geprüfter Commit zum Veröffentlichen.',
    'workspace.error.branchNameInvalid':
      'Der Branch-Name muss DNS-tauglich sein (Kleinbuchstaben, Ziffern, Bindestriche).',
    'workspace.error.branchCreateFailed':
      'Branch "{name}" konnte nicht erstellt werden (vielleicht existiert er schon).',
    'workspace.error.chatCreateFailed': 'Der Chat konnte nicht erstellt werden.',

    // ── Diff-Viewer ──
    'workspace.diff.loadFailed': 'Geänderte Seiten konnten nicht geladen werden ({status})',
    'workspace.diff.networkError': 'Netzwerkfehler beim Laden des Diffs.',
    'workspace.diff.mode.sideBySide': 'Nebeneinander',
    'workspace.diff.mode.highlight': 'Hervorheben',
    'workspace.diff.mode.onion': 'Onion',
    'workspace.diff.renderingShot': 'Screenshot wird erstellt…',
    'workspace.diff.beforeBranch': 'Vorher ({branch})',
    'workspace.diff.afterBranch': 'Nachher ({branch})',
    'workspace.diff.beforeRoute': 'Vorher: {route}',
    'workspace.diff.afterRoute': 'Nachher: {route}',
    'workspace.diff.diffRoute': 'Diff: {route}',
    'workspace.diff.hideOverlay': 'Diff-Overlay ausblenden',
    'workspace.diff.showOverlay': 'Diff-Overlay einblenden',
    'workspace.diff.before': 'vorher',
    'workspace.diff.after': 'nachher',
    'workspace.diff.loadingPages': 'Geänderte Seiten werden geladen…',
    'workspace.diff.retry': 'Erneut versuchen',
    'workspace.diff.reviewChanges': 'Änderungen prüfen',
    'workspace.diff.noChangedPages': 'Auf diesem Branch wurden keine geänderten Seiten gefunden.',
    'workspace.diff.unresolvedNote': 'Geänderte Dateien ohne zuordenbare Seiten-Route:',

    // ── Browser-Vergleich ──
    'workspace.bc.renderingShot': '{name} wird gerendert…',
    'workspace.bc.differences': 'Unterschiede',
    'workspace.bc.heading': 'Browser vergleichen',
    'workspace.bc.vs': 'vs.',
    'workspace.bc.hideDiff': 'Diff ausblenden',
    'workspace.bc.showDiff': 'Diff einblenden',
    'workspace.bc.closeTitle': 'Vergleich schließen',
  },
};
