# @rfany/rf

People's command line for [rollforward](https://github.com/spoj/rollforward): what its page does, from a shell or a desktop agent, as you.

    npm i -g @rfany/rf
    rf login https://rollforward.example.com

rf opens the page, which asks you to allow it if it shows the same code as rf; or make a token on the page, under Tokens, and
`rf login URL TOKEN`. `rf` alone lists the commands and `rf help COMMAND` gives one's usage; `rf help` is the guide for an agent, read before it first uses rf.

`rf site ask NAME WORKSPACE REASON` asks its owners to use your login there. `rf grants` describes the system and what runs may do; general platforms and high-risk or failed checks need an admin. Only admins allow hosts, with `rf logins allow SITE HOST --person EMAIL`; you remove one with `rf logins disallow SITE HOST`.
