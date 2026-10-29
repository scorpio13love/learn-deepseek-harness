/** s15 的 slash command：直接分派，不产生模型轮次。 */

export interface Command {
  name: string
  description: string
  run(args: string): string | Promise<string>
}

export interface CommandResult {
  handled: boolean
  output?: string
}

export class CommandRegistry {
  #commands = new Map<string, Command>()

  register(command: Command): () => void {
    if (this.#commands.has(command.name)) throw new Error(`command "${command.name}" is already registered`)
    this.#commands.set(command.name, command)
    return () => {
      if (this.#commands.get(command.name) === command) this.#commands.delete(command.name)
    }
  }

  list(): Command[] {
    return [...this.#commands.values()]
  }

  async dispatch(input: string): Promise<CommandResult> {
    if (!input.startsWith('/')) return { handled: false }
    const match = /^\/([A-Za-z0-9_-]+)\s*(.*)$/.exec(input)
    if (match === null) return { handled: true, output: 'invalid command' }
    const command = this.#commands.get(match[1]!)
    if (command === undefined) return { handled: true, output: `unknown command: /${match[1]}` }
    return { handled: true, output: await command.run(match[2] ?? '') }
  }
}
