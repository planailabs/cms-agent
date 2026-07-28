/**
 * Recovery paths — the flows that only exist when something goes wrong:
 * a real (positive) revert of an execution commit, the pull automatism
 * pausing on a rebase conflict and resuming after resolution, and the
 * deploy automatism pausing on a push failure and resuming once the remote
 * is healthy again. Each needs its own small agent journey.
 */
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { BenchClient } from '../lib/client';
import { benchRun } from '../lib/env';
import { judgeStep, recordAssert } from '../lib/judge';
import { loadJourney } from '../lib/journey';
import {
  chatState,
  runToExecution,
  waitForAutomatism,
  waitForPublication,
} from '../lib/agentFlow';

const SCENARIO = '06-recovery';
const client = new BenchClient();

const ok = (name: string, pass: boolean, detail = '') => {
  recordAssert(SCENARIO, name, pass, detail);
  expect(pass, `${name}: ${detail}`).toBe(true);
};

let branchId: string;

const mainBranchId = async (): Promise<string> => {
  if (branchId) return branchId;
  const branches = (await client.get('/api/branches')).json as {
    branches: { id: string; name: string }[];
  };
  branchId = branches.branches.find((b) => b.name === 'main')!.id;
  return branchId;
};

/** Newest commit sha of a branch via the git API. */
const headSha = async (branch: string): Promise<string> => {
  const res = (await client.get(`/api/git/commits?branch=${branch}`)).json as {
    commits?: { sha: string }[];
  };
  return res.commits![0].sha;
};

describe('recovery paths', () => {
  it('resume-automatism guard: nothing to resume → 404', async () => {
    const created = (await client.req('POST', '/api/chats', { branchId: await mainBranchId() }))
      .json as { chat: { id: string } };
    const res = await client.req('POST', `/api/chats/${created.chat.id}/resume-automatism`, {});
    ok('resume without a paused automatism → 404', res.status === 404, `got ${res.status}`);
  });

  it('positive revert: an execution commit is reverted on the work branch', async () => {
    const bid = await mainBranchId();
    const { chatId, workBranch } = await runToExecution(
      client,
      SCENARIO,
      bid,
      'Change the main headline on the About page to exactly "Revert Bench". ' +
        'Simple content change — propose your plan right away without asking questions.',
    );
    const execSha = await headSha(workBranch);

    const noSha = await client.req('POST', `/api/branches/${bid}/revert`, {});
    ok('revert without sha → 400', noSha.status === 400);

    const revert = await client.req('POST', `/api/branches/${bid}/revert`, { sha: execSha });
    const revertSha = (revert.json as { revertSha?: string }).revertSha;
    ok('revert succeeds with a revert sha', revert.status === 200 && !!revertSha, revert.text.slice(0, 200));

    const commits = (await client.get(`/api/git/commits?branch=${workBranch}`)).json as {
      commits?: { sha: string; message?: string }[];
    };
    ok(
      'work branch head is the revert commit',
      commits.commits?.[0]?.sha?.startsWith(revertSha!.slice(0, 12)) === true ||
        commits.commits?.[0]?.sha === revertSha,
      `head=${commits.commits?.[0]?.sha} revert=${revertSha}`,
    );

    const pages = (await client.get(`/api/diff/${chatId}/pages`)).json as {
      changedFiles?: string[];
    };
    ok(
      'diff is empty again after the revert',
      (pages.changedFiles ?? []).length === 0,
      JSON.stringify(pages.changedFiles),
    );
  }, 900_000);

  it('pull automatism pauses on a rebase conflict and recovers', async () => {
    const bid = await mainBranchId();

    // A published About change must exist on main so a restore can create the
    // conflicting main-side commit. The e2e journey provides it in full runs;
    // standalone runs make their own.
    const history = () =>
      client.get(`/api/branches/${bid}/history`).then(
        (r) => (r.json as { commits?: { sha: string }[] }).commits ?? [],
      );
    if (!loadJourney()) {
      const setup = await runToExecution(
        client,
        SCENARIO,
        bid,
        'Change the main headline on the About page to exactly "Setup Bench". ' +
          'Simple content change — propose your plan right away without asking questions.',
      );
      const preview = (await client.req('POST', `/api/chats/${setup.chatId}/finalize`, {
        summary: 'Recovery setup: About headline',
      })).json as { sha?: string };
      const pub = (await client.req('POST', `/api/chats/${setup.chatId}/publish`, {
        sha: preview.sha,
      })).json as { publicationId?: string };
      const status = await waitForPublication(client, pub.publicationId!);
      ok('setup journey published', status === 'succeeded', status);
    }

    // Conflict chat forks from the current main head…
    const { chatId } = await runToExecution(
      client,
      SCENARIO,
      bid,
      'Change the main headline on the About page to exactly "Conflict Bench". ' +
        'Simple content change — propose your plan right away without asking questions.',
    );

    // …then main moves underneath it: restore the OLDEST version of exactly
    // the files the agent touched → the main-side commit overlaps the work
    // branch's change whatever file the agent actually edited.
    const changed = ((await client.get(`/api/diff/${chatId}/pages`)).json as {
      changedFiles?: string[];
    }).changedFiles ?? [];
    ok('conflict execution changed files', changed.length > 0, JSON.stringify(changed));
    const commits = await history();
    const restore = await client.req('POST', `/api/branches/${bid}/restore`, {
      sha: commits[commits.length - 1].sha,
      paths: changed,
    });
    const restoreSha = (restore.json as { restoreSha?: string | null }).restoreSha;
    ok(
      'conflicting main-side restore commit',
      restore.status === 200 && !!restoreSha,
      `${restore.status} restoreSha=${restoreSha}`,
    );

    const sync = await client.req('POST', `/api/chats/${chatId}/sync`, {});
    ok('sync accepted', sync.status === 202);

    const paused = await waitForAutomatism(client, chatId, {
      until: ['paused', 'succeeded', 'failed'],
      timeoutMs: 240_000,
    });
    ok('pull automatism paused on the conflict', paused.pausedSeen, `status=${paused.status} err=${paused.lastError}`);

    // The failure invoked an agent (in its own agent chat, so this chat's
    // turnPhase says nothing). Deterministic signal while paused: conflict
    // markers still in the file = agent mid-resolution, keep waiting; markers
    // gone = resolved but not resumed, the user-resume path is safe.
    const aboutContent = async (): Promise<string> =>
      ((await client.get(`/api/files/${chatId}?path=${encodeURIComponent('src/pages/about.astro')}`))
        .json as { content?: string }).content ?? '';
    const hasMarkers = (c: string) => /^<{7}( |$)/m.test(c) && /^>{7}( |$)/m.test(c);

    const deadline = Date.now() + 600_000;
    let recovered = false;
    let cleanPolls = 0;
    while (Date.now() < deadline && !recovered) {
      const st = await waitForAutomatism(client, chatId, {
        until: ['succeeded', 'failed'],
        timeoutMs: 15_000,
        pollMs: 3000,
      });
      if (st.status === 'succeeded') {
        recordAssert(SCENARIO, 'conflict resolution path', true, 'agent resolved and self-resumed');
        const guard = await client.req('POST', `/api/chats/${chatId}/resume-automatism`, {});
        ok('resume after self-resume → 404', guard.status === 404, `got ${guard.status}`);
        recovered = true;
      } else if (st.status === 'failed') {
        ok('pull automatism recovered', false, `status=failed err=${st.lastError}`);
      } else if (st.status === 'paused' && !hasMarkers(await aboutContent())) {
        // Two consecutive clean reads — the agent may be mid-write between
        // clearing the markers and finishing the resolution.
        if (++cleanPolls < 2) continue;
        const resume = await client.req('POST', `/api/chats/${chatId}/resume-automatism`, {});
        ok('user resume accepted', resume.status === 200, `${resume.status} ${resume.text.slice(0, 150)}`);
        const final = await waitForAutomatism(client, chatId, {
          until: ['succeeded', 'failed'],
          timeoutMs: 240_000,
        });
        ok('pull automatism succeeds after resume', final.status === 'succeeded', `status=${final.status} err=${final.lastError}`);
        recovered = true;
      } else {
        cleanPolls = 0;
      }
    }
    ok('pull automatism recovered', recovered, 'still paused with markers at deadline');

    // The rebase moved the work branch onto the restored main; judge the
    // resolution quality from the resulting conflict-file content.
    const st = await chatState(client, chatId);
    const about = (await client.get(`/api/files/${chatId}?path=${encodeURIComponent('src/pages/about.astro')}`))
      .json as { content?: string };
    const verdict = await judgeStep({
      scenario: SCENARIO,
      step:
        'A rebase conflict on the About page (work branch changed the headline to "Conflict Bench"; main reverted it to the original) paused the sync automatism; the agent was invoked to resolve it.',
      criteria:
        'The About page source is valid (no conflict markers like <<<<<<< or >>>>>>>) and keeps a single coherent headline — ideally the work branch\'s "Conflict Bench".',
      artifacts: [
        { kind: 'text', label: 'about.astro after resolution', content: about.content ?? '(missing)' },
        { kind: 'json', label: 'chat state', content: JSON.stringify(st.automatism, null, 2) },
      ],
    });
    expect(verdict.pass, verdict.reasoning).toBe(true);
  }, 1_500_000);

  it('deploy automatism pauses on a push failure and resumes once fixed', async () => {
    const bid = await mainBranchId();
    const { chatId } = await runToExecution(
      client,
      SCENARIO,
      bid,
      'Add the line "Deploy Bench was here." to the end of the main content on the home page. ' +
        'Simple content change — propose your plan right away without asking questions.',
    );
    const preview = (await client.req('POST', `/api/chats/${chatId}/finalize`, {
      summary: 'Recovery: deploy pause/resume',
    })).json as { sha?: string };
    ok('finalize returns a sha', !!preview.sha);

    // Break the deploy remote (read-only bare repo → push fails)…
    const remote = benchRun().deployRemotePath;
    spawnSync('chmod', ['-R', 'a-w', remote]);
    let remoteBroken = true;
    const healRemote = () => {
      if (remoteBroken) {
        spawnSync('chmod', ['-R', 'u+w', remote]);
        remoteBroken = false;
      }
    };

    try {
      const publish = (await client.req('POST', `/api/chats/${chatId}/publish`, {
        sha: preview.sha,
      })).json as { publicationId?: string; deployChatId?: string };
      ok('publish accepted', !!publish.publicationId && !!publish.deployChatId);

      const paused = await waitForAutomatism(client, publish.deployChatId!, {
        until: ['paused', 'succeeded', 'failed'],
        timeoutMs: 240_000,
        pollMs: 1000,
      });
      ok('deploy automatism paused on the broken remote', paused.pausedSeen, `status=${paused.status} err=${paused.lastError}`);

      // …fix it immediately so whichever actor resumes (the invoked agent or
      // this test) the retried step succeeds.
      healRemote();

      const settled = await waitForAutomatism(client, publish.deployChatId!, {
        until: ['succeeded', 'failed'],
        timeoutMs: 300_000,
        pollMs: 3000,
        idleExit: true,
      });
      if (settled.status === 'succeeded') {
        recordAssert(SCENARIO, 'deploy resume path', true, 'agent self-resumed after the fix');
        const guard = await client.req('POST', `/api/chats/${publish.deployChatId}/resume-automatism`, {});
        ok('resume after self-resume → 404', guard.status === 404, `got ${guard.status}`);
      } else if (settled.status === 'paused') {
        const resume = await client.req('POST', `/api/chats/${publish.deployChatId}/resume-automatism`, {});
        const resumeJson = resume.json as { resumed?: string };
        // resumed is the flow-qualified type, e.g. 'deploy:git-push'
        ok('user resume accepted for the deploy', resume.status === 200 && !!resumeJson.resumed?.startsWith('deploy'), `${resume.status} ${resume.text.slice(0, 150)}`);
        const final = await waitForAutomatism(client, publish.deployChatId!, {
          until: ['succeeded', 'failed'],
          timeoutMs: 240_000,
        });
        ok('deploy succeeds after resume', final.status === 'succeeded', `status=${final.status} err=${final.lastError}`);
      } else {
        ok('deploy automatism recovered', false, `status=${settled.status} err=${settled.lastError}`);
      }

      const pubStatus = await waitForPublication(client, publish.publicationId!, 120_000);
      ok('publication succeeded after recovery', pubStatus === 'succeeded', pubStatus);

      const log = spawnSync('git', ['-C', remote, 'log', '--oneline', 'main'], { encoding: 'utf8' });
      ok(
        'deploy remote received the recovered merge',
        log.stdout.split('\n').filter(Boolean).length >= 2,
        log.stdout.slice(0, 150),
      );
    } finally {
      healRemote();
    }
  }, 1_500_000);
});
