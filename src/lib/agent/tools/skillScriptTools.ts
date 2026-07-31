/**
 * run_skill_script — run a script a skill ships, in the same bubblewrap jail
 * every site command uses.
 *
 * The model names a DECLARED script, never a path: the registry resolved the
 * file, so nothing the model says can point at another one. Arguments go as
 * argv (no shell), the skill's own directory is mounted read-only, and the
 * defaults are the safe end of every axis — read-only worktree, no network,
 * EXECUTE only — widened solely by flags the skill (or an admin overlay)
 * declared.
 */
import path from 'node:path';
import { z } from 'zod';
import { ensureSandbox, execSandboxed } from '@/lib/sandbox';
import { skillsForChat } from '../plugins';
import type { SkillScript } from '../skillScripts';
import { registerTool, type ToolDef } from './registry';
import { ALL_PHASES } from '../types';

/** Where a skill's own directory appears inside the jail. */
export const SKILL_MOUNT = '/skill';

/** argv for the jail: declared paths are relative to the skill dir. */
export const scriptArgv = (script: SkillScript, args: string[], mount: string): string[] => [
  script.argv[0],
  path.posix.join(mount, script.argv[1]),
  ...script.argv.slice(2),
  ...args,
];

const runSkillScriptTool: ToolDef = {
  name: 'run_skill_script',
  description:
    'Run a script that one of your available skills ships. The skill and script ' +
    'names are listed in your system prompt; load the skill with use_skill first ' +
    'to learn what arguments it expects. Scripts run sandboxed and, unless the ' +
    'skill declares otherwise, cannot write to the site or reach the network.',
  schema: z.object({
    skill: z.string().min(1).describe('Skill name exactly as listed in the system prompt'),
    script: z.string().min(1).describe('Script id as listed beside that skill'),
    args: z.array(z.string()).max(20).default([]).describe('Arguments passed to the script'),
    timeoutSeconds: z.number().int().positive().max(600).default(120),
  }),
  phases: ALL_PHASES,
  kinds: ['workflow', 'deployment'],
  async execute(input, ctx) {
    const skills = skillsForChat(ctx.worktreePath);
    const skill = skills.find((s) => s.name.toLowerCase() === input.skill.toLowerCase());
    if (!skill) {
      return JSON.stringify({
        error: `Unknown skill "${input.skill}". Available: ${skills.map((s) => s.name).join(', ') || '(none)'}`,
      });
    }
    const script = skill.scripts.find((s) => s.id.toLowerCase() === input.script.toLowerCase());
    if (!script) {
      return JSON.stringify({
        error:
          `Skill "${skill.name}" has no script "${input.script}". ` +
          `It ships: ${skill.scripts.map((s) => s.id).join(', ') || '(none)'}`,
      });
    }
    if (ctx.workflowPhase !== 'execute' && !script.flags.plan) {
      return JSON.stringify({
        error: `"${script.id}" runs only in the execute phase — it is not declared safe for planning.`,
      });
    }

    const sb = await ensureSandbox();
    // none-mode (dev fallback) has no mounts, so the script keeps its host path.
    const mount = sb.mode === 'none' ? skill.dir : SKILL_MOUNT;
    const result = await execSandboxed(sb, scriptArgv(script, input.args, mount), {
      cwd: ctx.worktreePath,
      sessionKey: ctx.chatId,
      timeoutMs: input.timeoutSeconds * 1000,
      readOnlyWorktree: !script.flags.write,
      network: script.flags.network === true,
      extraRoBinds: sb.mode === 'none' ? [] : [[skill.dir, SKILL_MOUNT]],
    });
    return JSON.stringify({
      exitCode: result.timedOut ? 'timeout' : result.code,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  },
};

export function registerSkillScriptTools(): void {
  registerTool(runSkillScriptTool);
}
