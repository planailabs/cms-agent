/**
 * use_skill — loads a plugin skill's full SKILL.md instructions into the
 * conversation on demand. The available skills (name + description) are
 * listed in the system prompt; this keeps their bodies out of context until
 * actually needed.
 */
import { z } from 'zod';
import { skillsForChat } from '../plugins';
import { registerTool, type ToolDef } from './registry';
import { ALL_PHASES } from '../types';

const useSkillTool: ToolDef = {
  name: 'use_skill',
  description:
    'Load the full instructions of an available plugin skill by name. ' +
    'The available skills are listed in your system prompt.',
  schema: z.object({
    name: z.string().min(1).describe('Skill name exactly as listed in the system prompt'),
  }),
  phases: ALL_PHASES,
  kinds: ['workflow', 'deployment', 'deployments'],
  async execute(input, ctx) {
    // Branch-local skills (worktree .agents/skills/) shadow installed ones
    const skills = skillsForChat(ctx.worktreePath);
    const skill = skills.find((s) => s.name.toLowerCase() === input.name.toLowerCase());
    if (!skill) {
      return JSON.stringify({
        error: `Unknown skill "${input.name}". Available: ${skills.map((s) => s.name).join(', ') || '(none)'}`,
      });
    }
    return `[skill ${skill.name} from plugin ${skill.plugin}]\n\n${skill.body}`;
  },
};

export function registerSkillTools(): void {
  registerTool(useSkillTool);
}
