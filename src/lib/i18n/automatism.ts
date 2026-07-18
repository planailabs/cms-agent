/**
 * Catalog: automatism engine + deploy/pull flow messages (persisted into
 * chats as role:'automatism' messages via the TranslatedMessage container)
 * and the step-bar labels. German follows the app's informal "du" register.
 */
import type { AreaCatalogs } from './types';

export const automatismCatalogs: AreaCatalogs = {
  en: {
    // ── engine ──
    'automatism.stepFailed':
      'Step "{step}" FAILED:\n{error}\n\nInvestigate and fix the cause, then call resume_automatism to re-run the failed step and continue. If a human decision is needed, explain what and why.',
    'automatism.takeover': 'Step "{step}" failed — the agent takes over in another chat.\n{error}',
    'automatism.recovered': 'Server restarted mid-flow — resuming automatically from step {step}.',

    // ── pull (Sync button) ──
    'pull.started': 'Sync started by {actor}: rebasing this draft onto the latest {target}.',
    'pull.conflicts':
      "Rebasing the draft onto {target} hit conflicts in:\n{files}\nThe rebase is paused in this chat's worktree (markers in place). Use list_conflicts / show_conflict, target_file for the incoming side, resolve each file (edit_file or resolve_conflict_take) keeping both sides' intent, then git_rebase_continue — repeat per replayed commit until the rebase completes — and finally call resume_automatism to finish the sync.",
    'pull.rebased':
      'Rebased the draft onto the latest {target} → {sha}. Note: the draft history was rewritten — review the preview again before publishing.',
    'pull.rebaseFailed': 'Rebasing onto {target} failed: {error}',
    'pull.done': 'Sync done — the draft is up to date with {target}.',

    // ── deploy ──
    'deploy.startedFlow':
      'Deployment of "{title}" started by {actor}: merge {workBranch} ({sha}) into {target}, then deploy via "{flow}".',
    'deploy.startedMergeOnly':
      'Deployment of "{title}" started by {actor}: merge {workBranch} ({sha}) into {target}, no deploy (non-default target).',
    'deploy.merged': 'Merged {workBranch} into {target} → {sha}.',
    'deploy.mergeFailed': 'Merge into {target} failed: {error}',
    'deploy.mergeConflicts':
      "Merging {workBranch} into {target} hit conflicts in:\n{files}\nThe conflicted merge is materialized in this chat's worktree (markers in place, merge in progress). Use list_conflicts / show_conflict to inspect, target_file for the incoming side, then resolve each file — edit_file for mixed resolutions, resolve_conflict_take for whole-side ones — keeping both sides' intent. Commit the merge with git_commit, and only then call resume_automatism to retry the merge and continue the deployment.",
    'deploy.failed':
      'Deploy of {sha} to {target} failed: {error}\n\nPublication id: {publicationId}\nLog tail:\n{log}',
    'deploy.stepDone': '{flow}: {step} done.',
    'deploy.flowSucceeded': 'Deploy via "{flow}" succeeded for {sha}.',
    'deploy.mergeOnlyDone': 'Merge-only publish done.',
    'deploy.succeeded': '{label}{live}{log}',
    'deploy.liveAt': '\nLive at: {url}',
    'deploy.logTail': '\n\nLog:\n{log}',
    'deploy.finished': 'Deployment finished — this chat and the source chat are archived.',

    // ── step-bar labels (fallback: raw registered step name) ──
    'automatism.step.merge': 'Merge',
    'automatism.step.deploy': 'Deploy',
    'automatism.step.verify': 'Verify',
    'automatism.step.finalize': 'Finalize',
    'automatism.step.pull': 'Pull',
    'automatism.step.push': 'Push',
    'automatism.step.build': 'Build',
    'automatism.step.artifact_info': 'Artifact info',
  },
  de: {
    // ── engine ──
    'automatism.stepFailed':
      'Schritt "{step}" FEHLGESCHLAGEN:\n{error}\n\nUntersuche und behebe die Ursache und rufe dann resume_automatism auf, um den fehlgeschlagenen Schritt erneut auszuführen und fortzufahren. Falls eine menschliche Entscheidung nötig ist, erkläre was und warum.',
    'automatism.takeover':
      'Schritt "{step}" fehlgeschlagen — der Agent übernimmt in einem anderen Chat.\n{error}',
    'automatism.recovered':
      'Der Server wurde mitten im Ablauf neu gestartet — es geht automatisch ab Schritt {step} weiter.',

    // ── pull (Sync-Button) ──
    'pull.started':
      'Sync gestartet von {actor}: dieser Entwurf wird auf den neuesten Stand von {target} rebased.',
    'pull.conflicts':
      'Beim Rebase des Entwurfs auf {target} gab es Konflikte in:\n{files}\nDer Rebase pausiert im Worktree dieses Chats (Konfliktmarker gesetzt). Nutze list_conflicts / show_conflict, target_file für die eingehende Seite, löse jede Datei (edit_file oder resolve_conflict_take) unter Erhalt der Absicht beider Seiten, dann git_rebase_continue — pro wiederholtem Commit, bis der Rebase abgeschlossen ist — und rufe zum Schluss resume_automatism auf, um den Sync zu beenden.',
    'pull.rebased':
      'Der Entwurf wurde auf den neuesten Stand von {target} rebased → {sha}. Hinweis: Die Entwurfs-Historie wurde neu geschrieben — prüfe die Vorschau erneut, bevor du veröffentlichst.',
    'pull.rebaseFailed': 'Rebase auf {target} fehlgeschlagen: {error}',
    'pull.done': 'Sync abgeschlossen — der Entwurf ist auf dem Stand von {target}.',

    // ── deploy ──
    'deploy.startedFlow':
      'Deployment von "{title}" gestartet von {actor}: {workBranch} ({sha}) wird in {target} gemerged, danach Deploy über "{flow}".',
    'deploy.startedMergeOnly':
      'Deployment von "{title}" gestartet von {actor}: {workBranch} ({sha}) wird in {target} gemerged; kein Deploy (Ziel ist nicht der Standard-Branch).',
    'deploy.merged': '{workBranch} wurde in {target} gemerged → {sha}.',
    'deploy.mergeFailed': 'Merge in {target} fehlgeschlagen: {error}',
    'deploy.mergeConflicts':
      'Beim Merge von {workBranch} in {target} gab es Konflikte in:\n{files}\nDer konfliktbehaftete Merge liegt im Worktree dieses Chats (Konfliktmarker gesetzt, Merge in Arbeit). Nutze list_conflicts / show_conflict zum Inspizieren, target_file für die eingehende Seite, und löse dann jede Datei — edit_file für gemischte Auflösungen, resolve_conflict_take für ganze Seiten — unter Erhalt der Absicht beider Seiten. Schließe den Merge mit git_commit ab und rufe erst danach resume_automatism auf, um den Merge zu wiederholen und das Deployment fortzusetzen.',
    'deploy.failed':
      'Deploy von {sha} nach {target} fehlgeschlagen: {error}\n\nPublication-ID: {publicationId}\nLog-Ende:\n{log}',
    'deploy.stepDone': '{flow}: Schritt {step} abgeschlossen.',
    'deploy.flowSucceeded': 'Deploy über "{flow}" erfolgreich für {sha}.',
    'deploy.mergeOnlyDone': 'Veröffentlichung ohne Deploy abgeschlossen (nur Merge).',
    'deploy.succeeded': '{label}{live}{log}',
    'deploy.liveAt': '\nLive unter: {url}',
    'deploy.logTail': '\n\nLog:\n{log}',
    'deploy.finished': 'Deployment abgeschlossen — dieser Chat und der Quell-Chat wurden archiviert.',

    // ── Schrittleisten-Labels ──
    'automatism.step.merge': 'Merge',
    'automatism.step.deploy': 'Deploy',
    'automatism.step.verify': 'Prüfen',
    'automatism.step.finalize': 'Abschluss',
    'automatism.step.pull': 'Pull',
    'automatism.step.push': 'Push',
    'automatism.step.build': 'Build',
    'automatism.step.artifact_info': 'Artefakt-Info',
  },
};
