# @rfany/rf

People's command line for [rollforward](https://github.com/spoj/rollforward): what its page does, from a shell or a desktop agent, as you.

Run with `npx` so you always stay on the latest version automatically:

    npx @rfany/rf@latest login https://rollforward.example.com

Or use short-lived Entra ID tokens via Azure CLI (no static token saved to disk):

    npx @rfany/rf@latest login https://rollforward.example.com --az

rf opens the page, which asks you to allow it if it shows the same code as rf; or make a token on the page, under Tokens, and
`npx @rfany/rf@latest login URL TOKEN`. `rf` alone lists the commands and `rf help COMMAND` gives one's usage; `rf help` is the guide for an agent, read before it first uses rf. Without saved config, help works offline; once signed in, it reads your current capabilities from the server.

`rf series owner WORKSPACE/SERIES EMAIL` explicitly transfers the whole series, not one instance; only its current owner or a workspace manager may do it. Old runs stop and execution consent is cleared. The incoming owner selects a series-wide ceiling with `rf series credentials WORKSPACE/SERIES --set OFFER,... --autonomous false`, or `--clear` for an explicit empty selection. The owner's acts and answers by whom the agent's ask named start runs under current consent. Other collaborators' words stay notes. Scheduled/autonomous execution needs `--autonomous true`. `rf new instance` never changes credentials; `rf new task` without `--creds` or `--clear` establishes no execution consent.

`rf site ask NAME WORKSPACE REASON` asks its owners to use your login there, or approves it at once where you may. `rf grants` describes the system and what runs may do; general platforms and high-risk or failed checks need an admin. Only admins allow hosts, with `rf logins allow SITE HOST --person EMAIL`; you remove one with `rf logins disallow SITE HOST`.

On servers with client VPN support, only people explicitly granted `vpn` see its commands in help; being an admin is not enough. `rf vpns` lists definitions and your connection states; sign in on the page. `rf site set NAME --via VPN` selects one for your website, `--via ''` clears it, and `rf sites` shows it. Opted-in admins manage definitions with `rf vpn add NAME fortinet HOST:PORT [--servercert pin-sha256:HASH]` and `rf vpn remove NAME`; admins grant access with `rf can vpn EMAIL|GROUP,...` and revoke it with `rf can vpn --clear`.
