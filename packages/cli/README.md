# mcp-tenant-pair-cli

Commander-based CLI wrapper around `mcp-tenant-pair`. Useful for shell scripts, smoke tests, and inspecting a SQLite-backed pair store.

## Install

```sh
npm install -g mcp-tenant-pair-cli
# or use directly:
npx mcp-tenant-pair-cli --help
```

## Subcommands

```
pair create        --member-id <id> [--display-name <name>] [--db <path>]
pair invite        --pair-id <id> --member-id <id> [--ttl <seconds>] [--db <path>]
pair list-members  --pair-id <id> [--db <path>]
member set-pref    --pair-id <id> --member-id <id> --key <k> --value <json> [--db <path>]
state get          --pair-id <id> [--namespace <ns>] [--db <path>]
state set          --pair-id <id> --member-id <id> --key <k> --value <json> [--namespace <ns>] [--db <path>]
conflict list      --pair-id <id> [--namespace <ns>] [--db <path>]
conflict resolve   --pair-id <id> [--namespace <ns>] [--db <path>]
```

`--db` defaults to `./tenant-pair.sqlite` in the current working directory.

`--value` accepts JSON. Strings must be quoted: `--value '"pizza"'`. Numbers and arrays unquoted: `--value 42`, `--value '[1,2,3]'`.

## Example

```sh
mcp-tenant-pair-cli pair create --member-id alice
# {"pairId":"...","inviteToken":"...","expiresAt":"..."}
mcp-tenant-pair-cli state set --pair-id <id> --member-id alice --key tonight --value '"pizza"'
mcp-tenant-pair-cli state get --pair-id <id>
```

## License

MIT, Copyright (c) 2026 Matthias Meyer (StudioMeyer)
