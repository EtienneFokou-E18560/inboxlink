# Branch ruleset

`default-branch.json` is the ruleset that protects `main`: changes arrive through a pull request, the CI `build` check must pass, and force pushes and deleting the branch are blocked. Repository admins can bypass it.

Rulesets on a private repository need GitHub Pro on the owner's account (currently from GitHub Education). If Pro lapses the rules stop being enforced. To recreate them:

```bash
gh api -X POST repos/EtienneFokou-E18560/inboxlink/rulesets --input .github/rulesets/default-branch.json
```

Change the ruleset in GitHub (Settings > Rules > Rulesets), then export it again here:

```bash
gh api repos/EtienneFokou-E18560/inboxlink/rulesets/<id> | jq '{name,target,enforcement,conditions,bypass_actors,rules}' > .github/rulesets/default-branch.json
```
