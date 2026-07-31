/**
 * Real-model end-to-end scenarios, one per way out of PLAN.
 *
 * Journey A asks to approve first (`/plan`): propose → approve → execute →
 * finalize → publish, judged at every checkpoint. Journey B takes the default
 * path, where the agent records its plan and implements it in the same turn,
 * and then exercises request-changes and the element-edit handoff on top of
 * it. Also here: ask_question with a turn-lock probe. All later scenarios
 * reuse this journey's data (journey.json).
 */
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { BenchClient, turnText } from '../lib/client';
import { benchRun } from '../lib/env';
import { judgeStep, recordAssert } from '../lib/judge';
import { loadJourney, saveJourney } from '../lib/journey';
import {
  chatState as flowChatState,
  driveToExecution,
  driveToPlan as flowDriveToPlan,
  noError,
} from '../lib/agentFlow';

const SCENARIO = '03-e2e';
const client = new BenchClient();

const J: {
  branchId?: string;
  chatId?: string;
  workBranch?: string;
  previewSha?: string;
  publicationId?: string;
  deployChatId?: string;
  chatB?: string;
} = {};

const ok = (name: string, pass: boolean, detail = '') => {
  recordAssert(SCENARIO, name, pass, detail);
  expect(pass, `${name}: ${detail}`).toBe(true);
};

const chatState = (chatId: string) => flowChatState(client, chatId);
const driveToPlan = (chatId: string, firstPrompt: string) =>
  flowDriveToPlan(client, SCENARIO, chatId, firstPrompt);

describe('e2e agent journey', () => {
  it('the /plan command makes the agent propose instead of implementing', async () => {
    const branches = (await client.get('/api/branches')).json as {
      branches: { id: string; name: string }[];
    };
    J.branchId = branches.branches.find((b) => b.name === 'main')!.id;
    const created = (await client.req('POST', '/api/chats', { branchId: J.branchId })).json as {
      chat: { id: string; workBranch: string };
    };
    J.chatId = created.chat.id;
    J.workBranch = created.chat.workBranch;

    // driveToPlan prefixes /plan — without it the agent has no propose_plan
    // tool and would implement straight away (journey B covers that path).
    const plan = await driveToPlan(
      J.chatId,
      'Change the main headline on the About page to exactly "Hello Bench". ' +
        'This is a simple content change — propose your plan right away without asking questions.',
    );

    const st = await chatState(J.chatId);
    ok('the command switched the chat into plan mode', st.planMode === true);
    ok('the turn stopped on the proposal', st.pendingQuestion?.toolName === 'propose_plan');
    // The command is stored on the message the user sent — that is what the
    // transcript renders as a chip beside it.
    const history = (await client.get(`/api/chat/history?chatId=${J.chatId}`)).json as {
      messages?: { role: string; command?: string }[];
    };
    ok(
      'the message kept its command for the transcript chip',
      (history.messages ?? []).some((m) => m.role === 'user' && m.command === 'plan'),
    );
    // The stripped text is what the agent works from — no stray "/plan".
    ok(
      'the command prefix is stripped from the message text',
      !(history.messages ?? []).some((m) => m.role === 'user' && String((m as { content?: string }).content ?? '').startsWith('/plan')),
    );
    const verdict = await judgeStep({
      scenario: SCENARIO,
      step: 'The user asked to change the About page headline to "Hello Bench"; the agent proposed a plan.',
      criteria:
        'The plan proposes editing the About page so its main headline reads "Hello Bench", with no unrelated or destructive steps.',
      artifacts: [{ kind: 'json', label: 'proposed plan', content: JSON.stringify(plan, null, 2) }],
    });
    expect(verdict.pass, verdict.reasoning).toBe(true);
  }, 600_000);

  it('approve runs the execution and commits the change', async () => {
    const events = await client.collectEvents(
      J.chatId!,
      async () => {
        const res = await client.req('POST', `/api/chats/${J.chatId}/approve-plan`, {});
        if (res.status !== 200) throw new Error(`approve-plan: ${res.status} ${res.text}`);
      },
      ['question', 'done', 'error'],
      600_000,
    );
    ok('execution turn streams without error', noError(events));
    const tools = events.filter((e) => e.event === 'tool_start').map((e) => String(e.data.name));
    ok('execution used write tools', tools.some((t) => ['write_file', 'edit_file'].includes(t)), tools.join(','));

    const st = await chatState(J.chatId!);
    ok(
      'execution ends on the finish card (or idle)',
      st.pendingQuestion?.toolName === 'finish_execution' || st.turnPhase === 'idle',
      `turnPhase=${st.turnPhase} pending=${st.pendingQuestion?.toolName}`,
    );

    const commits = (await client.get(`/api/git/commits?branch=${J.workBranch}`)).json as {
      commits?: { sha: string }[];
    };
    ok('work branch has an execution commit', (commits.commits?.length ?? 0) >= 2);
  }, 700_000);

  it('diff endpoints show the change on the About page', async () => {
    const pages = (await client.get(`/api/diff/${J.chatId}/pages`)).json as {
      pages?: { route: string }[];
      changedFiles?: string[];
    };
    ok(
      'diff pages include /about',
      (pages.pages ?? []).some((p) => p.route.includes('about')),
      JSON.stringify(pages.pages),
    );

    const after = await client.getBinary(`/api/diff/${J.chatId}/shot?route=/about&kind=after`);
    ok('after-shot renders a PNG', after.status === 200 && after.type.includes('image/png'));
    const diff = await client.getBinary(`/api/diff/${J.chatId}/shot?route=/about&kind=diff`);
    ok('diff-shot renders a PNG', diff.status === 200 && diff.type.includes('image/png'));
    const meta = await client.get(`/api/diff/${J.chatId}/shot?route=/about&kind=diff&meta=1`);
    ok('diff meta returns pixel counts', meta.status === 200);

    const verdict = await judgeStep({
      scenario: SCENARIO,
      step: 'After the agent executed the change, the visual-diff "after" screenshot of /about was captured.',
      criteria: 'The page shows the headline "Hello Bench".',
      artifacts: [
        { kind: 'screenshot', label: 'about-after', content: after.buffer.toString('base64') },
      ],
    });
    expect(verdict.pass, verdict.reasoning).toBe(true);
  }, 600_000);

  it('finalize → publish → deploy pushes to the git remote', async () => {
    const preview = await client.req('POST', `/api/chats/${J.chatId}/finalize`, {
      summary: 'Bench journey: About headline change',
    });
    const previewJson = preview.json as { ok?: boolean; sha?: string };
    ok('finalize returns the reviewed sha', preview.status === 200 && !!previewJson.sha);
    J.previewSha = previewJson.sha;
    ok('chat stays in execute for review', (await chatState(J.chatId!)).workflowPhase === 'execute');

    // finalize resumes the paused agent to close its finish_execution card.
    // A human reviews the preview before pressing Publish; a test that posts
    // immediately would be racing that wrap-up turn.
    const idleBy = Date.now() + 120_000;
    while (Date.now() < idleBy && (await chatState(J.chatId!)).turnPhase !== 'idle') {
      await new Promise((r) => setTimeout(r, 1000));
    }
    ok('the wrap-up turn finished before publish', (await chatState(J.chatId!)).turnPhase === 'idle');

    const publish = await client.req('POST', `/api/chats/${J.chatId}/publish`, {
      sha: J.previewSha,
    });
    const pubJson = publish.json as { publicationId?: string; deployChatId?: string };
    ok(
      'publish accepted (202)',
      publish.status === 202 && !!pubJson.publicationId,
      `got ${publish.status}: ${publish.text.slice(0, 200)}`,
    );
    J.publicationId = pubJson.publicationId;
    J.deployChatId = pubJson.deployChatId;

    let status = 'queued';
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      const res = (await client.get(`/api/publications?id=${J.publicationId}`)).json as {
        publication?: { status: string };
      };
      status = res.publication?.status ?? status;
      if (status === 'succeeded' || status === 'failed') break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    ok('publication succeeded', status === 'succeeded', `status=${status}`);

    const log = spawnSync('git', ['-C', benchRun().deployRemotePath, 'log', '--oneline', 'main'], {
      encoding: 'utf8',
    });
    const lines = log.stdout.trim().split('\n').filter(Boolean);
    ok('deploy remote received the merge', lines.length >= 2, log.stdout.slice(0, 200));

    saveJourney({
      chatId: J.chatId!,
      branchId: J.branchId!,
      workBranch: J.workBranch!,
      previewSha: J.previewSha!,
      publicationId: J.publicationId!,
      deployChatId: J.deployChatId!,
    });
  }, 700_000);

  it('journey B: the default path implements without an approval step', async () => {
    const created = (await client.req('POST', '/api/chats', { branchId: J.branchId })).json as {
      chat: { id: string };
    };
    J.chatB = created.chat.id;

    // sync (pull automatism): rebases the fresh work branch onto main
    const sync = await client.req('POST', `/api/chats/${J.chatB}/sync`, {});
    ok('sync automatism accepted', sync.status === 202);
    await new Promise((r) => setTimeout(r, 4000));

    // No /plan here: the agent records its plan and carries it out in one
    // turn. This is the default every chat gets.
    const afterFirst = await driveToExecution(
      client,
      SCENARIO,
      J.chatB,
      'Add a short tagline under the main headline on the home page saying "Fast sites".',
    );
    ok('chat B reached execute without an approval', afterFirst.workflowPhase === 'execute');
    ok('chat B is not in plan mode', afterFirst.planMode !== true);
    // It may rest on finish_execution or a question — but never on a plan
    // waiting to be approved, which is the whole point of the default path.
    ok(
      'no plan was submitted for approval',
      afterFirst.pendingQuestion?.toolName !== 'propose_plan',
      String(afterFirst.pendingQuestion?.toolName),
    );
    const events = await client.collectEvents(
      J.chatB,
      async () => {
        const res = await client.req('POST', `/api/chats/${J.chatB}/request-changes`, {
          feedback:
            'Use the tagline "Blazing fast sites" instead, and say exactly where it will be placed.',
        });
        if (res.status !== 200) throw new Error(`request-changes: ${res.status} ${res.text}`);
      },
      ['question', 'done', 'error'],
      420_000,
    );
    ok('revision turn streams without error', noError(events));
    // request-changes returns the chat to PLAN; the agent re-plans and, with
    // no approval in the way, implements the revision in the same turn.
    const st = await chatState(J.chatB);
    ok('the revision lands back in execute', st.workflowPhase === 'execute', st.workflowPhase);
    const verdict = await judgeStep({
      scenario: SCENARIO,
      step: 'The user asked for the tagline "Blazing fast sites" instead; the agent revised its plan and carried it out.',
      criteria:
        'The reply shows the revision was made with the wording "Blazing fast sites" and says where it was placed.',
      artifacts: [
        { kind: 'text', label: 'revision turn', content: turnText(events) || '(no text)' },
        {
          kind: 'json',
          label: 'recorded plan',
          content: JSON.stringify(st.pendingQuestion?.input ?? {}, null, 2),
        },
      ],
    });
    expect(verdict.pass, verdict.reasoning).toBe(true);
  }, 900_000);

  it('ask_question pauses the turn; concurrent message hits the turn lock', async () => {
    const created = (await client.req('POST', '/api/chats', { branchId: J.branchId })).json as {
      chat: { id: string };
    };
    const chatC = created.chat.id;

    const events = await client.collectEvents(
      chatC,
      async () => {
        const first = await client.req('POST', '/api/chat/message', {
          chatId: chatC,
          type: 'message',
          text:
            "I want to change the site's color scheme. Before planning anything, ask me which colors I prefer — use your question tool.",
        });
        if (first.status !== 202) throw new Error(`first message: ${first.status}`);
        const second = await client.req('POST', '/api/chat/message', {
          chatId: chatC,
          type: 'message',
          text: 'Also make it fast.',
        });
        ok('second message during the turn is rejected (turn lock)', second.status === 409, `got ${second.status}`);
      },
      ['question', 'done', 'error'],
      420_000,
    );
    ok('question turn streams without error', noError(events));
    const st = await chatState(chatC);
    // A color-scheme prompt legitimately resolves to either question tool
    const tool = st.pendingQuestion?.toolName;
    ok('agent asked a question', tool === 'ask_question' || tool === 'pick_color', tool);

    const answer = tool === 'pick_color' ? '#1e3a8a' : 'Dark blue and white.';
    const answerEvents = await client.sendMessageAndCollect(chatC, answer, {
      type: 'answer',
      timeoutMs: 420_000,
    });
    ok('answer resumes the turn without error', noError(answerEvents));
  }, 900_000);

  it('stop interrupts a running turn', async () => {
    const created = (await client.req('POST', '/api/chats', { branchId: J.branchId })).json as {
      chat: { id: string };
    };
    const chatS = created.chat.id;

    const events = await client.collectEvents(
      chatS,
      async () => {
        const first = await client.req('POST', '/api/chat/message', {
          chatId: chatS,
          type: 'message',
          text:
            'Read every page of this site one file at a time and write me a long report about ' +
            'the writing style of each one.',
        });
        if (first.status !== 202) throw new Error(`message: ${first.status}`);
        // Stop once the turn is demonstrably running — before that there is
        // nothing to interrupt and the endpoint says so.
        const idle = await client.req('POST', '/api/chat/stop', { chatId: chatS });
        ok('stop before the turn starts is refused', idle.status === 202 || idle.status === 409, `got ${idle.status}`);
        await new Promise((r) => setTimeout(r, 8_000));
        const stop = await client.req('POST', '/api/chat/stop', { chatId: chatS });
        ok('stop is accepted while the turn runs', stop.status === 202, `got ${stop.status}`);
      },
      ['stopped', 'error'],
      300_000,
    );
    ok('the turn reports it stopped', events.some((e) => e.event === 'stopped'), noError(events) ? '' : 'errored');

    // The chat is usable again: idle, unlocked, and it takes the next message.
    await expect
      .poll(async () => (await chatState(chatS)).turnPhase, { timeout: 60_000 })
      .toBe('idle');
    const after = await client.sendMessageAndCollect(chatS, 'Never mind — just say OK.', {
      timeoutMs: 300_000,
    });
    ok('a stopped chat runs its next turn normally', noError(after) && after.length > 0);
  }, 600_000);

  it('element-edit handoff captures a screenshot and re-plans', async () => {
    // Journey B has no pending question, so the handoff arrives as a normal
    // message with the annotated screenshot attached (the same path the UI
    // takes; a paused turn would instead be answered with it).
    const annotations = {
      url: `http://main.localhost:${benchRun().proxyPort}/`,
      route: '/',
      viewport: { width: 1280, height: 900 },
      moves: [],
      strokes: [
        {
          points: [
            [100, 100],
            [220, 160],
            [340, 130],
          ],
        },
      ],
      comments: [{ n: 1, x: 180, y: 220, text: 'Make this headline bigger and bolder' }],
    };
    const events = await client.collectEvents(
      J.chatB!,
      async () => {
        const res = await client.req('POST', '/api/chat/element-handoff', {
          chatId: J.chatB,
          note: 'See the annotated screenshot for what to change.',
          annotations,
        });
        if (res.status !== 202) throw new Error(`element-handoff: ${res.status} ${res.text}`);
      },
      ['question', 'done', 'error'],
      600_000,
    );
    ok('handoff turn streams without error', noError(events));

    const uploads = events.filter((e) => e.event === 'tool_start').map((e) => String(e.data.name));
    recordAssert(SCENARIO, 'handoff turn tool usage (info)', true, uploads.join(','));
    const text = turnText(events);
    const st = await chatState(J.chatB!);
    const verdict = await judgeStep({
      scenario: SCENARIO,
      step:
        'The user annotated the live page (a drawn stroke and comment pin #1 "Make this headline bigger and bolder") and handed off to the agent; the agent responded.',
      criteria:
        'The response engages with the annotated feedback about making the headline bigger/bolder (reading the screenshot or the annotation metadata), instead of ignoring it.',
      artifacts: [
        { kind: 'text', label: 'agent response', content: text || '(no text)' },
        {
          kind: 'json',
          label: 'pending question after handoff',
          content: JSON.stringify(st.pendingQuestion ?? {}, null, 2),
        },
      ],
    });
    expect(verdict.pass, verdict.reasoning).toBe(true);
  }, 900_000);

  it('journey B: the handoff work lands and the chat rests in review (for 05)', async () => {
    const st = await chatState(J.chatB!);
    // The handoff turn may have left the chat back in PLAN (the handoff
    // returns it there) — drive it forward so 05 finds committed work.
    if (st.workflowPhase !== 'execute') {
      await driveToExecution(
        client,
        SCENARIO,
        J.chatB!,
        'Go ahead and implement the change from the annotated screenshot now.',
      );
    }
    ok('journey B is in execute with the work done', (await chatState(J.chatB!)).workflowPhase === 'execute');
    const prev = await client.req('POST', `/api/chats/${J.chatB}/finalize`, {
      summary: 'Bench journey B: annotated tagline change',
    });
    ok('chat B finalize accepted', prev.status === 200, String(prev.status));
    // Unpublished on purpose: 05 drives the diff-viewer UI on this chat.
    ok('chat B rests in execute, reviewable', (await chatState(J.chatB!)).workflowPhase === 'execute');
    saveJourney({ ...loadJourney()!, chatB: J.chatB! });
  }, 900_000);

  it('post-journey probes: history, restore roundtrip, guards', async () => {
    const history = (await client.get(`/api/branches/${J.branchId}/history`)).json as {
      commits?: { sha: string }[];
    };
    const commits = history.commits ?? [];
    ok('branch history lists the published commits', commits.length >= 2, `${commits.length} commits`);

    const headSha = commits[0].sha;
    const initialSha = commits[commits.length - 1].sha;
    const restore = await client.req('POST', `/api/branches/${J.branchId}/restore`, {
      sha: initialSha,
    });
    ok('restore applies an old version as a new commit', restore.status === 200);
    const restoreBack = await client.req('POST', `/api/branches/${J.branchId}/restore`, {
      sha: headSha,
    });
    ok('restore back to the published head', restoreBack.status === 200);

    const badRevert = await client.req('POST', `/api/branches/${J.branchId}/revert`, {
      sha: 'deadbeefdead',
    });
    ok('revert of an unknown sha is a client error', badRevert.status >= 400 && badRevert.status < 500);

    const republish = await client.req('POST', `/api/chats/${J.chatId}/publish`, {
      sha: J.previewSha,
    });
    ok('second publish is rejected', republish.status >= 400, `got ${republish.status}`);

    const gitCommit = (await client.get(`/api/git/commit?sha=${J.previewSha}`)).json as {
      patch?: string;
    };
    ok('git show returns the reviewed commit patch', typeof gitCommit.patch === 'string');

    const pub = (await client.get(`/api/publications?id=${J.publicationId}`)).json as {
      publication?: { status: string; artifacts?: unknown[] };
    };
    ok('publication detail includes the deploy record', pub.publication?.status === 'succeeded');

    // archive-on-done: the published workflow chat lands in the archive
    let archived = false;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !archived) {
      const res = (await client.get('/api/chats/archived')).json as {
        chats?: { id: string }[];
      };
      archived = (res.chats ?? []).some((c) => c.id === J.chatId);
      if (!archived) await new Promise((r) => setTimeout(r, 3000));
    }
    ok('published chat is archived (archive-on-done)', archived);
  }, 600_000);
});
