/**
 * Shell Completion Scripts — Generate completion scripts for bash, zsh, and fish.
 *
 * These scripts handle completing:
 *   - Top-level commands
 *   - Sub-commands (server add, session list, etc.)
 *   - Global flags (--format, --verbose, etc.)
 */

const COMMANDS = ["connect", "server", "config", "session", "prompt", "exec", "cancel", "completions"];
const SERVER_SUBCOMMANDS = ["add", "list", "remove", "test"];
const SESSION_SUBCOMMANDS = ["new", "list", "show", "close", "history"];
const CONFIG_SUBCOMMANDS = ["show", "init"];
const COMPLETIONS_SUBCOMMANDS = ["bash", "zsh", "fish"];
const FORMATS = ["text", "json", "quiet"];

export function bashCompletion(): string {
	return `# ahpx bash completion
_ahpx_completions() {
    local cur prev commands
    COMPREPLY=()
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"
    commands="${COMMANDS.join(" ")}"

    case "\${COMP_WORDS[1]}" in
        server)
            COMPREPLY=( $(compgen -W "${SERVER_SUBCOMMANDS.join(" ")}" -- "$cur") )
            return 0
            ;;
        session)
            COMPREPLY=( $(compgen -W "${SESSION_SUBCOMMANDS.join(" ")}" -- "$cur") )
            return 0
            ;;
        config)
            COMPREPLY=( $(compgen -W "${CONFIG_SUBCOMMANDS.join(" ")}" -- "$cur") )
            return 0
            ;;
        completions)
            COMPREPLY=( $(compgen -W "${COMPLETIONS_SUBCOMMANDS.join(" ")}" -- "$cur") )
            return 0
            ;;
    esac

    case "$prev" in
        --format)
            COMPREPLY=( $(compgen -W "${FORMATS.join(" ")}" -- "$cur") )
            return 0
            ;;
    esac

    if [[ "$cur" == -* ]]; then
        COMPREPLY=( $(compgen -W "--format --verbose --json-strict --help --version" -- "$cur") )
        return 0
    fi

    COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
    return 0
}
complete -F _ahpx_completions ahpx
`;
}

export function zshCompletion(): string {
	return `#compdef ahpx
# ahpx zsh completion

_ahpx() {
    local -a commands
    commands=(
        'connect:Connect to an AHP server'
        'server:Manage saved server connections'
        'config:Manage ahpx configuration'
        'session:Manage agent sessions'
        'prompt:Send a prompt to an agent session'
        'exec:One-shot prompt with temp session'
        'cancel:Cancel the active turn'
        'completions:Generate shell completion scripts'
    )

    _arguments -C \\
        '--format[Output format]:format:(${FORMATS.join(" ")})' \\
        '--verbose[Enable debug logging]' \\
        '--json-strict[Suppress non-JSON stderr output]' \\
        '--help[Show help]' \\
        '--version[Show version]' \\
        '1:command:->command' \\
        '*::arg:->args'

    case $state in
        command)
            _describe -t commands 'ahpx commands' commands
            ;;
        args)
            case $words[1] in
                server)
                    _describe -t subcommands 'server subcommands' \\
                        '(${SERVER_SUBCOMMANDS.map((s) => `"${s}"`).join(" ")})'
                    ;;
                session)
                    _describe -t subcommands 'session subcommands' \\
                        '(${SESSION_SUBCOMMANDS.map((s) => `"${s}"`).join(" ")})'
                    ;;
                config)
                    _describe -t subcommands 'config subcommands' \\
                        '(${CONFIG_SUBCOMMANDS.map((s) => `"${s}"`).join(" ")})'
                    ;;
                completions)
                    _describe -t subcommands 'completions subcommands' \\
                        '(${COMPLETIONS_SUBCOMMANDS.map((s) => `"${s}"`).join(" ")})'
                    ;;
            esac
            ;;
    esac
}

_ahpx "$@"
`;
}

export function fishCompletion(): string {
	return `# ahpx fish completion

# Disable file completions by default
complete -c ahpx -f

# Top-level commands
${COMMANDS.map((c) => `complete -c ahpx -n "__fish_use_subcommand" -a "${c}"`).join("\n")}

# Global flags
complete -c ahpx -l format -d "Output format" -xa "${FORMATS.join(" ")}"
complete -c ahpx -l verbose -d "Enable debug logging"
complete -c ahpx -l json-strict -d "Suppress non-JSON stderr output"

# server subcommands
${SERVER_SUBCOMMANDS.map((s) => `complete -c ahpx -n "__fish_seen_subcommand_from server" -a "${s}"`).join("\n")}

# session subcommands
${SESSION_SUBCOMMANDS.map((s) => `complete -c ahpx -n "__fish_seen_subcommand_from session" -a "${s}"`).join("\n")}

# config subcommands
${CONFIG_SUBCOMMANDS.map((s) => `complete -c ahpx -n "__fish_seen_subcommand_from config" -a "${s}"`).join("\n")}

# completions subcommands
${COMPLETIONS_SUBCOMMANDS.map((s) => `complete -c ahpx -n "__fish_seen_subcommand_from completions" -a "${s}"`).join("\n")}
`;
}
