export const SHELLS = ['bash', 'zsh', 'fish'] as const;
const COMMANDS = ['login', 'logout', 'whoami', 'tools', 'completion'];
const TOOLS = ['ls', 'describe', 'call'];

type Options = Record<string, { type: 'string' | 'boolean' }>;

// Static scripts built from the CLI's own option table, so a new flag is completed in every shell.
// Every command is offered every flag: parseArgs accepts them all globally, so a per-command list would only drift.
export function completionScript(shell: string, options: Options): string | undefined {
  const flags = Object.keys(options).map((name) => `--${name}`);
  const valueFlags = Object.keys(options).filter((name) => options[name].type === 'string').map((name) => `--${name}`);
  const shells = SHELLS.join(' ');
  if (shell === 'bash') {
    return `# bash completion for amcp
_amcp() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" prev="\${COMP_WORDS[COMP_CWORD-1]}" i w
  local -a pos=()
  case "$prev" in ${valueFlags.join('|')}) return;; esac
  for ((i = 1; i < COMP_CWORD; i++)); do
    w="\${COMP_WORDS[i]}"
    case "$w" in
      ${valueFlags.join('|')}) ((i++));;
      -*) ;;
      *) pos+=("$w");;
    esac
  done
  if [[ "$cur" == -* ]]; then
    COMPREPLY=($(compgen -W "${flags.join(' ')}" -- "$cur"))
  elif ((\${#pos[@]} == 0)); then
    COMPREPLY=($(compgen -W "${COMMANDS.join(' ')}" -- "$cur"))
  elif ((\${#pos[@]} == 1)); then
    case "\${pos[0]}" in
      tools) COMPREPLY=($(compgen -W "${TOOLS.join(' ')}" -- "$cur"));;
      completion) COMPREPLY=($(compgen -W "${shells}" -- "$cur"));;
    esac
  fi
}
complete -F _amcp amcp
`;
  }
  if (shell === 'zsh') {
    return `#compdef amcp
# zsh completion for amcp
_amcp() {
  local i w
  local -a pos
  case "$words[CURRENT-1]" in ${valueFlags.join('|')}) return;; esac
  for ((i = 2; i < CURRENT; i++)); do
    w="$words[i]"
    case "$w" in
      ${valueFlags.join('|')}) ((i++));;
      -*) ;;
      *) pos+=("$w");;
    esac
  done
  if [[ "$words[CURRENT]" == -* ]]; then
    compadd -- ${flags.join(' ')}
  elif (( \${#pos} == 0 )); then
    compadd -- ${COMMANDS.join(' ')}
  elif (( \${#pos} == 1 )); then
    case "$pos[1]" in
      tools) compadd -- ${TOOLS.join(' ')};;
      completion) compadd -- ${shells};;
    esac
  fi
}
if [ "$funcstack[1]" = "_amcp" ]; then _amcp "$@"; else compdef _amcp amcp; fi
`;
  }
  if (shell === 'fish') {
    const lines = [
      '# fish completion for amcp',
      'complete -c amcp -f',
      `complete -c amcp -n '__fish_use_subcommand' -a '${COMMANDS.join(' ')}'`,
      `complete -c amcp -n '__fish_seen_subcommand_from tools; and not __fish_seen_subcommand_from ${TOOLS.join(' ')}' -a '${TOOLS.join(' ')}'`,
      `complete -c amcp -n '__fish_seen_subcommand_from completion; and not __fish_seen_subcommand_from ${shells}' -a '${shells}'`,
      ...Object.keys(options).map((name) => `complete -c amcp -l ${name}${options[name].type === 'string' ? ' -r' : ''}`),
    ];
    return lines.join('\n') + '\n';
  }
  return undefined;
}
