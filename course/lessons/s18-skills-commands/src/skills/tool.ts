/**
 * 模型可见的 `load_skill(name)` 工具。
 *
 * catalog 是“菜单”，这个工具是“点单”：模型看到描述后，只有真正需要时
 * 才把某个技能的正文拉进上下文。
 */

import { defineTool, errorResult, textResult } from '../tools.ts'
import type { ToolDefinition } from '../tools.ts'
import type { SkillCatalog } from './catalog.ts'

export function createLoadSkillTool(catalog: SkillCatalog): ToolDefinition {
  return defineTool({
    name: 'load_skill',
    description:
      'Load the full instructions of a skill listed in the catalog. '
      + 'Call it only when the current task matches that skill description.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Exact skill name from the catalog.',
        },
      },
      required: ['name'],
    },
    run(args) {
      const { name } = args as { name?: unknown }
      if (typeof name !== 'string' || name.length === 0) {
        return errorResult('load_skill expects { name: string }')
      }
      try {
        return textResult(catalog.load(name))
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error))
      }
    },
  })
}
