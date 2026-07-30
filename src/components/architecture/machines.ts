/**
 * Architecture page — chapter 2: the state machines. Every one of these is
 * persisted, so each diagram is also a description of what survives a restart.
 */
import type { ArchSection } from './types';

export const machineSections: ArchSection[] = [
  {
    id: 'workflow-phase',
    title: 'Workflow phase machine',
    intro: `Every chat is in exactly one workflow phase, stored on the
      <code>Chat</code> row, and the phase decides which tools the agent is
      allowed to call. Transitions are HTTP endpoints, never chat text — the
      model cannot talk its way into write access. Two exceptions are
      deliberate and both are audited: <code>start_execution</code>, which
      moves forward inside a running turn, and <code>return_to_plan</code>,
      which only ever moves backwards.`,
    diagrams: [
      {
        caption: 'Phases and their transitions',
        code: `
stateDiagram-v2
  state "PLAN — read tools only" as plan
  state "EXECUTE — write tools, review, publish" as execute
  state "PUBLISHED — deploy automatism owns the chat" as published

  [*] --> plan: chat created
  plan --> plan: request-changes
  plan --> execute: start_execution
  execute --> plan: request-changes
  execute --> plan: return_to_plan
  execute --> plan: element handoff
  execute --> execute: finalize
  execute --> published: publish
  published --> [*]: deploy finalize
`,
      },
      {
        caption: 'Recording a plan does not stop the turn',
        code: `
sequenceDiagram
  autonumber
  participant M as Agent (PLAN run)
  participant W as startExecution
  participant DB as Database
  participant G as Git engine
  participant E as Agent (EXECUTE run)

  M->>W: start_execution with the plan
  W->>G: ensureBranch + read base sha
  Note over W,G: git prep happens BEFORE the phase flip
  W->>DB: phase to execute, guarded on entityVersion
  alt version moved
    DB-->>W: 0 rows updated
    W-->>M: 409 — the chat changed, reload
  else accepted
    W->>DB: immutable Approval — plan hash, base sha, idempotency key
    W->>DB: state snapshot broadcast — the user sees the plan
    W-->>M: the run ends here
    M->>E: fresh run, EXECUTE prompt and write tools
  end
`,
      },
    ],
    notes: `<ul>
      <li><strong>The plan is recorded, never submitted.</strong> There is one
        way out of PLAN: <code>start_execution</code>. The agent writes the plan
        it intends to follow and implements it — the user reads it as it happens
        and steers with request-changes, rather than being handed a form to sign
        before anything can start. Where a decision genuinely belongs to them,
        the agent asks a question instead.</li>
      <li><strong>Ordering is a correctness property.</strong> Branch creation
        and sha reads run before the phase update. A git failure after the flip
        would leave a chat in EXECUTE with no approval row behind it.</li>
      <li><strong>Optimistic concurrency, not last-writer-wins.</strong> Every
        transition is a conditional update on <code>Chat.entityVersion</code>.
        Two editors deciding at once means one of them gets "the chat changed
        while you were deciding" rather than a silent overwrite.</li>
      <li><strong>The audit row is best-effort, the transition is not.</strong>
        If writing the <code>Approval</code> fails it is logged and the
        transition still stands — stranding a chat mid-flip to protect a log
        entry would be the worse failure. Idempotency keys are unique, so a
        retried request cannot double-record.</li>
      <li><strong>Approvals bind content.</strong> The <code>Approval</code>
        row is an audit record, not a gate: a recorded plan stores the hash of
        the exact plan and the base sha, a publish stores the exact reviewed
        sha. Publishing is where a human still decides, and if the branch moves
        after they reviewed it, it refuses and asks for a fresh look.</li>
      <li><strong>Deployment chats are a separate kind.</strong> Their persisted
        phase is a static <code>published</code>, but their tools are gated as
        if they were in EXECUTE, because that is where merge conflicts get
        resolved.</li>
    </ul>`,
    source: ['src/lib/agent/workflow.ts', 'src/lib/autonomy.ts', 'src/pages/api/chats/[id]'],
  },

  {
    id: 'turn-machine',
    title: 'Agent turn machine (server)',
    intro: `A turn is resumable because every step of it is written down before
      it happens. <code>Chat.turnPhase</code> is the checkpoint: a process that
      dies mid-turn leaves a row that says exactly what it was doing, and a
      <code>continue</code> message picks the turn back up from there.`,
    diagrams: [
      {
        caption: 'turnPhase',
        code: `
stateDiagram-v2
  [*] --> idle

  idle --> running: message, answer, continue
  running --> tool_pending: tools dispatched
  tool_pending --> running: results appended
  running --> waiting_for_answer: client-side tool
  waiting_for_answer --> idle: answer or cancel
  running --> idle: turn ends
  tool_pending --> running: resumed after a restart

  note left of tool_pending
    Persisted BEFORE the tools run.
    A row still marked active with
    no live turn owning it is what
    the resume affordance offers.
  end note
`,
      },
      {
        caption: 'One round of the loop',
        code: `
flowchart TD
  start(["Round begins"]) --> stream["Stream a completion"]
  stream --> err{"Context length error?"}
  err -->|"yes, first time this round"| compact["Summarize into a compaction checkpoint<br/>and retry the same round"]
  compact --> stream
  err -->|"no"| calls{"Tool calls returned?"}

  calls -->|"none"| finish["Persist the assistant message<br/>phase to idle, emit done"]
  calls -->|"some"| gate{"finish_execution with a dirty worktree?"}

  gate -->|"yes"| reject["Reject it — commit first<br/>the round repeats"]
  reject --> stream
  gate -->|"no"| client{"Any client-side tool?"}

  client -->|"yes"| pause["phase to waiting_for_answer<br/>persist the prompt, then broadcast"]
  client -->|"no"| exec["phase to tool_pending"]

  exec --> loopdet{"Same tool, same arguments,<br/>3 times in the last 5 calls?"}
  loopdet -->|"yes"| warn["Return a loop warning instead of executing"]
  loopdet -->|"no"| run["Execute through the MCP bridge"]
  warn --> append
  run --> append["Append results, phase back to running"]
  append --> moved{"Workflow phase moved?"}
  moved -->|"no"| start
  moved -->|"yes"| boundary["End the run — the handler starts<br/>a new one in the new phase"]
`,
      },
      {
        caption: 'A phase change is a run boundary, not a mid-run switch',
        code: `
sequenceDiagram
  autonumber
  participant H as Handler
  participant R1 as PLAN run
  participant R2 as EXECUTE run
  participant DB as Database

  H->>R1: prompt + tools built for PLAN
  R1->>R1: read, search, decide
  R1->>DB: start_execution — record the plan, phase to execute
  R1-->>H: phase_changed
  Note over H,R1: the run stops here — the browser is never told the turn ended
  H->>DB: re-read the recorded plan and the task list
  H->>R2: prompt + tools built for EXECUTE
  R2->>R2: write, commit, finish
  R2-->>H: finished
`,
      },
    ],
    notes: `<ul>
      <li><strong>Persist, then broadcast.</strong> The pause state is written
        before the <code>question</code> event goes out, so a browser that
        reconnects a millisecond later still finds the pending question.</li>
      <li><strong>Questions are free.</strong> A client-side tool decrements the
        round counter — waiting on a human should never consume the loop
        budget.</li>
      <li><strong>The dirty-worktree gate is where "one commit per execution"
        is enforced.</strong> <code>finish_execution</code> is refused while
        anything is uncommitted, with the file list in the tool result, so the
        agent commits and retries instead of the CMS quietly committing on its
        behalf.</li>
      <li><strong>The loop detector does not execute the call.</strong> Three
        identical calls inside a five-call sliding window return an explanation
        instead of a result. The window catches straight repeats and A-B-A-B
        alternation while leaving legitimate re-reads alone.</li>
      <li><strong>Compaction is durable.</strong> The summary is appended as a
        <code>compaction</code> message and becomes the new start of the
        model-facing window; the original rows stay in the database, so the
        transcript a human reads is never truncated.</li>
      <li><strong>A workflow-phase change ends the run.</strong> The system
        prompt and the tool set are built once, before the loop, from one
        phase. When <code>start_execution</code> or <code>return_to_plan</code>
        moves the phase, that snapshot stops describing what the agent may do —
        so the run returns <code>phase_changed</code> and the handler starts a
        fresh one whose prompt and tools match the new phase. Nothing is
        broadcast in between, so a single turn is what the user sees. Four
        flips in one turn is treated as a plan/execute ping-pong and ends the
        turn with a question instead of a fifth run.</li>
      <li><strong>Streaming is accumulated by hand.</strong> Some
        OpenAI-compatible backends resend the full tool-argument JSON on every
        fragment instead of streaming deltas; concatenating those would corrupt
        every call. The accumulator detects a complete-JSON buffer followed by a
        new object and replaces rather than appends.</li>
    </ul>`,
    source: ['src/lib/agent/toolLoop.ts', 'src/lib/agent/handler.ts', 'src/lib/agent/chatState.ts'],
  },

  {
    id: 'client-machine',
    title: 'Composer machine (browser)',
    intro: `The browser runs its own small phase machine for the composer and
      the thinking indicator. It is driven by the transcript event stream, and
      it is deliberately optimistic: it enters <em>waiting</em> the moment you
      press send, before any server response.`,
    diagrams: [
      {
        code: `
stateDiagram-v2
  [*] --> idle
  idle --> waiting: send a message
  waiting --> streaming: first text delta
  waiting --> tool: tool_start
  streaming --> tool: tool_start
  tool --> waiting: tool_end, after a 500ms dwell
  tool --> tool: next tool — only the name changes
  streaming --> compacting: compaction_start
  compacting --> waiting: compaction finished
  streaming --> question: client-side tool prompt
  waiting --> question: client-side tool prompt
  question --> waiting: answer or cancel
  streaming --> idle: done
  waiting --> idle: done
  idle --> error: error event
  waiting --> error: error event
  streaming --> error: error event
  error --> waiting: retry
`,
      },
    ],
    notes: `<ul>
      <li><strong>One entry point.</strong> Every phase change goes through
        <code>transition()</code>, which finalizes any half-streamed text and
        clears the previous phase's transient fields. Setting the phase
        directly is what leaks a stale question card into the next turn.</li>
      <li><strong>The 500&nbsp;ms dwell is intentional.</strong> Fast tools would
        otherwise flash a spinner for one frame. The pending timer is cancelled
        by any other transition, so the delay can never strand the UI.</li>
      <li><strong>A snapshot never downgrades an optimistic wait.</strong> The
        server sends full state snapshots, and the client derives its composer
        phase from them — with one conservative rule: a snapshot that still says
        <em>idle</em> cannot pull the client out of <em>waiting</em>. The
        <code>done</code>, <code>error</code> and <code>question</code> stream
        events own that edge, because they are ordered with the transcript.</li>
      <li><strong>The first message creates the chat.</strong> Until then it is
        a draft with no database row. Sending materializes it — and if the user
        opened another chat while that round trip was in flight, the result is
        discarded rather than posted into the wrong conversation.</li>
    </ul>`,
    source: [
      'src/components/chat/actions/chat/stateMachine.ts',
      'src/components/chat/actions/chat/sse.ts',
    ],
  },

  {
    id: 'automatism',
    title: 'Automatism engine',
    intro: `Automatisms are the agent-less flows: publishing and syncing. An
      automatism type is an ordered list of named steps; the engine runs them
      server-side and posts each event into a chat as a message the agent can
      read. When a step fails the flow pauses instead of dying, and the agent is
      invoked to fix the cause.`,
    diagrams: [
      {
        caption: 'Automatism status',
        code: `
stateDiagram-v2
  [*] --> running: startAutomatism
  running --> running: step done, advance
  running --> paused: step threw
  paused --> running: resume_automatism
  running --> done: all steps done
  running --> failed: type not registered
  done --> [*]
  failed --> [*]

  note right of paused
    The step index is persisted, so
    a resume re-runs exactly the
    step that failed — and a boot
    re-advances from it. Steps must
    therefore be retry-safe.
  end note
`,
      },
      {
        caption: 'Failure handling',
        code: `
sequenceDiagram
  autonumber
  participant E as Automatism engine
  participant DB as Database
  participant HC as Home chat
  participant AC as Agent chat
  participant AG as Agent turn

  E->>E: step throws
  E->>DB: status paused, record the step and the error
  alt the step named a different chat
    E->>HC: "handled in the other chat" notice
  end
  E->>AC: post the failure with its context
  E->>AG: acquire the chat's turn lock — waiting up to two minutes
  alt a client-tool question is already pending
    E->>AG: answer it with the interruption so the turn can run
  else nothing pending
    E->>AG: continue turn — nothing added to the transcript
  end
  AG->>AG: agent fixes the cause
  AG->>E: resume_automatism
  E->>E: re-run the failed step
`,
      },
    ],
    notes: `<ul>
      <li><strong>Failures can be routed.</strong> A step throws a failure that
        may name a different chat to handle it. A merge conflict during publish
        is raised in the deployment chat, which owns the worktree and the edit
        tools; a home chat only gets a note that the work moved.</li>
      <li><strong>A pending question would otherwise deadlock the fix.</strong>
        A chat waiting on a client-side tool refuses a plain continue turn. The
        engine answers that question with the interruption instead, so the
        failure is actually handled rather than sitting forever behind a card.</li>
      <li><strong>Restart recovery is unconditional.</strong> Anything still
        marked <code>running</code> at boot belonged to a process that died
        mid-step. It re-advances from its persisted index after posting a notice
        into the chat — which is exactly why steps must be safe to run twice.</li>
      <li><strong>Progress is part of the chat state snapshot.</strong> The step
        bar in the UI is derived from the automatism row plus the registered
        step names, not from a bespoke event, so it survives a reload.</li>
      <li><strong>Messages are localized at render time.</strong> Automatism
        messages are stored as a translation key plus parameters with a rendered
        English fallback, so the same row reads correctly for every viewer and
        still gives the model plain English context.</li>
    </ul>`,
    source: ['src/lib/automatism.ts', 'src/lib/agent/tools/automatismTools.ts'],
  },

  {
    id: 'deploy',
    title: 'Publish: the deploy automatism',
    intro: `Publishing is not a request that blocks — it is an automatism on its
      own chat. The generic shape is merge, deploy, finalize. A flow that
      declares its own phases gets one automatism step per phase, so each shows
      up in the step bar and can pause and resume on its own.`,
    diagrams: [
      {
        caption: 'Step chain',
        code: `
stateDiagram-v2
  direction LR

  [*] --> merge

  state "merge — work branch into target, under the target lock" as merge
  state "flow steps — push, build, deploy, one automatism step each" as flowsteps
  state "verify — the flow confirms the deployment landed" as verify
  state "finalize — reset the work branch, archive both chats" as finalize
  state "deploy — single step for flows without phases, and merge-only targets" as generic

  merge --> generic: flow declares no steps
  merge --> flowsteps: flow declares steps
  flowsteps --> flowsteps: next phase
  flowsteps --> verify
  verify --> finalize
  generic --> finalize
  finalize --> [*]
`,
      },
      {
        caption: 'When the merge conflicts',
        code: `
sequenceDiagram
  autonumber
  participant A as Automatism
  participant G as Git engine
  participant P as Publication row
  participant DC as Deployment chat
  participant AG as Agent

  A->>G: merge work branch into target
  G-->>A: conflicts
  A->>G: abort the forward merge
  A->>G: begin the reverse merge in the WORK branch worktree
  Note over A,G: the deployment chat's tools operate on exactly that worktree
  A->>P: keep status running, write the conflict into the log
  A->>DC: pause and post the conflicting files
  DC->>AG: invoke the agent here
  AG->>G: resolve and commit the reverse merge
  AG->>A: resume_automatism
  A->>G: retry the forward merge — now clean
  A->>P: rebind the publication to the merge commit
`,
      },
    ],
    notes: `<ul>
      <li><strong>The approval is re-checked at merge time.</strong> The publish
        endpoint compares the reviewed sha against the branch head synchronously,
        but the merge runs later. If anything moved the branch in between — a
        sync, another chat — the merge refuses. Once a conflict round has begun
        the check is waived, because the reverse-merge commit legitimately moves
        the head.</li>
      <li><strong>The publish card stays honest while paused.</strong> The
        publication row remains <code>running</code> and the conflict is appended
        to its log, so the UI shows work in progress rather than a success that
        has not happened.</li>
      <li><strong>The merge moves the target for everyone.</strong> After it
        lands, a state snapshot is emitted for every live chat on that branch —
        each of them just became "target ahead" and needs its Sync button
        without a reload.</li>
      <li><strong>Retrying does not rebuild.</strong> Artifacts are sealed per
        sha — a tarball plus a per-file checksum manifest — and flows reconcile
        by commit sha first, so a retry after a failed upload reuses the exact
        bytes that were reviewed.</li>
      <li><strong>Deploy flows only run for the default branch.</strong>
        Publishing into any other long-lived branch is a pure merge, recorded as
        a merge-only publication.</li>
      <li><strong>Finalize cycles the branch.</strong> The work branch is reset
        onto the updated target so its preview keeps working from the archive,
        both the workflow chat and the deployment chat are archived, and the next
        change starts a new chat.</li>
    </ul>`,
    source: ['src/lib/publish/publisher.ts', 'src/lib/publish/flows.ts', 'src/lib/publish/artifact.ts'],
  },

  {
    id: 'sync',
    title: 'Sync: the pull automatism',
    intro: `When the target branch moves ahead — someone else published — a chat
      can rebase its work branch onto it. Same engine, two steps, and the same
      pause-and-fix behaviour when the rebase conflicts.`,
    diagrams: [
      {
        code: `
stateDiagram-v2
  direction LR

  [*] --> guards

  state "guards — workflow chat, not archived, no active automatism or publication" as guards
  state "pull — rebase onto the target, or continue an interrupted one" as pull
  state "paused — chat forced into EXECUTE so the agent can edit" as paused
  state "finalize — restore the phase the chat was in" as finalize

  guards --> pull: accepted
  guards --> [*]: 409, already running
  pull --> paused: conflicts
  paused --> pull: resume_automatism
  pull --> finalize: rebased cleanly
  finalize --> [*]
`,
      },
    ],
    notes: `<ul>
      <li><strong>The step is retry-safe by inspection.</strong> On resume it
        checks whether a rebase is still in progress: if the agent resolved but
        did not continue, it continues; if the rebase is already finished, it
        starts a fresh one. Either way one resume does the right thing.</li>
      <li><strong>Conflicts force EXECUTE and then give the phase back.</strong>
        Resolving needs write tools, so a chat in PLAN is moved to EXECUTE and
        the original phase is remembered on the automatism payload. The finalize
        step restores it.</li>
      <li><strong>Two guards, because they cover different rows.</strong> The
        automatism check looks at this chat, but a running deploy lives on the
        <em>deployment</em> chat and would be missed — so a running publication
        for this chat blocks a sync as well. Rebasing under a pending merge
        would rewrite the exact state someone approved.</li>
      <li><strong>Double-clicks are handled in process.</strong> The database
        guard is check-then-create, so an in-flight set of chat ids stops a
        second click from starting a parallel sync.</li>
    </ul>`,
    source: ['src/lib/publish/publisher.ts', 'src/lib/git/engine.ts', 'src/lib/agent/tools/conflictTools.ts'],
  },

  {
    id: 'preview-lifecycle',
    title: 'Preview instance lifecycle',
    intro: `One dev server per branch, started on demand and stopped when nobody
      is looking. The manager holds the process handles in memory and the
      routing table in the listener; the expensive part — an installed worktree
      — outlives the process it was installed for.`,
    diagrams: [
      {
        code: `
stateDiagram-v2
  [*] --> absent

  absent --> starting_deps: ensureInstance
  starting_deps --> starting_server: deps ready
  starting_server --> ready: answers HTTP
  starting_server --> failed: exited early
  failed --> absent: error kept for the boot page
  absent --> starting_deps: retry, forcing a re-install

  ready --> stopped: idle timeout
  ready --> stopped: evicted, LRU
  ready --> absent: the child crashed
  stopped --> [*]

  note right of starting_deps
    Skipped while the package hash
    stamp matches. Installs are
    serialized process wide.
  end note

  note left of stopped
    Pinned branches are exempt from
    both the idle sweep and eviction.
  end note
`,
      },
    ],
    notes: `<ul>
      <li><strong>An in-flight start is joined, never restarted.</strong> A
        second caller returns the same promise. Deleting the entry that the
        in-flight start already registered used to orphan the child and restart
        the branch on every boot-page reload.</li>
      <li><strong>Installs are conditional on a hash, not a timestamp.</strong>
        The installed <code>package.json</code> hash is stamped into
        <code>node_modules</code>. It re-installs when the checkout has no
        dependencies, when the agent changed site dependencies mid-chat, or when
        a boot-page retry asks for a repair.</li>
      <li><strong>Failure is fast and specific.</strong> The start races the HTTP
        probe against the child's exit. A dev server that dies during startup
        surfaces its own last few kilobytes of output rather than the browser
        waiting out the full timeout for a generic message.</li>
      <li><strong>Pinned branches are the floor.</strong> Branches chats fork
        from are pinned: the idle sweeper skips them and the capacity evictor
        will run over the instance cap rather than stop one. A cold primary
        branch means every new chat starts by watching a dev server boot.</li>
      <li><strong>Idleness is measured at the listener.</strong> The native proxy
        writes per-branch access timestamps; the sweeper takes the later of that
        and its own last-used marker, so traffic that never reaches Node still
        counts as activity.</li>
    </ul>`,
    source: ['src/lib/preview/manager.ts', 'src/lib/preview/devices.ts', 'src/lib/site/index.ts'],
  },
];
