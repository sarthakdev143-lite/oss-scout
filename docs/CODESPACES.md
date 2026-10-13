# Run oss-scout in GitHub Codespaces

oss-scout runs untrusted repository code only inside Docker. If your own machine can't run Docker,
a GitHub Codespace can: it is a Linux machine with 2 cores and 8 GB of RAM, with Docker running inside
it. It is free within your monthly quota, and GitHub asks for no payment method.

This repository includes everything the codespace needs:

* `.devcontainer/devcontainer.json`: the container. It uses a small Node 22 Debian image with
  Docker-in-Docker, and recommends the two token secrets.
* `.devcontainer/setup.sh`: runs once when the codespace is created. It installs pinned Bun and
  opencode versions, the plugin's dependencies, and the state directory.
* `oss-scout.config.codespaces.json`: the config used inside the codespace. `devcontainer.json` sets
  `OSS_SCOUT_CONFIG` to it. Your local checkout ignores this file.

## The free quota

| | GitHub Free | GitHub Pro (e.g. Student Pack) |
|---|---|---|
| Compute per month | 120 core-hours = **60 hours** on a 2-core machine | 180 core-hours = 90 hours |
| Storage per month | 15 GB-month | 20 GB-month |

* **You can't be billed by accident.** Without a payment method, usage is blocked when the quota runs
  out. You can't start the codespace again until the monthly reset.
* **Compute counts only while the codespace is running.** Storage counts for as long as the codespace
  exists, including while it is stopped.
* **A codespace that stays stopped for 30 days is deleted, together with its state.** Opening it
  resets the countdown.

## One-time setup

1. **Put this folder on GitHub** as a private repository:

   ```bash
   gh repo create oss-scout --private --source . --push
   ```

2. **Create the tokens.**
   * Read token: a fine-grained PAT at <https://github.com/settings/personal-access-tokens/new>.
     Set the resource owner to you and repository access to "Public repositories (read-only)". It
     needs no extra permissions.
   * Write token: optional, and only needed for queue mode. Create a classic PAT with only the
     `public_repo` scope at <https://github.com/settings/tokens/new?scopes=public_repo>.
3. **Add the tokens as Codespaces secrets** at <https://github.com/settings/codespaces> → *New
   secret*. Give each secret access to your oss-scout repository.
   * `OSS_SCOUT_GITHUB_TOKEN`: the read token.
   * `OSS_SCOUT_WRITE_TOKEN`: the write token (optional).

   Don't use `GITHUB_TOKEN`. In a codespace, that variable already holds the codespace's own token,
   which only covers the oss-scout repository. GitHub also doesn't allow secret names that start with
   `GITHUB_`. If `github.tokenEnv` is still `GITHUB_TOKEN`, `doctor` reports a failure.
4. **Change two settings** on the same page:
   * *Default idle timeout*: up to 240 minutes. The codespace, and oss-scout with it, stops after this
     long without input from you. A longer timeout lets oss-scout keep working after you leave, but
     it uses more hours.
   * *Default retention period*: 30 days, which is the maximum.

## Create the codespace

On the repository page, open **Code → Codespaces → Create codespace on main** and choose the 2-core
machine. The first creation takes a few minutes while `setup.sh` runs.

If you added the secrets after the codespace was created, stop the codespace and start it again.
Secrets are loaded when the codespace starts.

## First run

In the codespace terminal, run:

```bash
bun run cli doctor
```

The output should show these lines (exit code 2 means a `[FAIL]` line needs fixing):

```
[ok]   Config: /workspaces/oss-scout/oss-scout.config.codespaces.json
[ok]   State dir: /workspaces/.oss-scout
[info] Running in GitHub Codespace …
[ok]   Read token: OSS_SCOUT_GITHUB_TOKEN set (fine-grained; login <you>)
[ok]   Sandbox: docker … available
```

Then start opencode in the repository folder:

```bash
opencode --standalone
```

Inside opencode, run `/oss-doctor`, then `/oss-status`. The background loop runs while this opencode
is running in this folder. The VS Code terminal keeps running when you close the browser tab, until
the codespace stops.

## Day to day

1. Open the codespace from <https://github.com/codespaces>. If opencode isn't running, start it with
   `opencode --standalone` in the repository folder.
2. Check `/oss-status` and `/oss-queue`.
3. Review an item in a second terminal with `bun run cli show <id>`. You can also open the files in
   `/workspaces/.oss-scout/queue/<id>/`: `REVIEW.md`, `diff.patch` and `PR_BODY.md`.
4. Approve it with `/oss-approve <id> <digest>`, or with `bun run cli approve <id> <digest>` in a
   terminal.
5. When you're done, stop the codespace from the Codespaces menu in the bottom-left corner, or from
   <https://github.com/codespaces>. Next time, oss-scout continues from `/workspaces/.oss-scout`.

The codespace also opens in a phone browser, so you can do steps 2–4 from your phone.

## What the preset changes

| Setting | Value | Why |
|---|---|---|
| `stateDir` | `/workspaces/.oss-scout` | `/workspaces` survives container rebuilds, and this folder is outside the git checkout. |
| `github.tokenEnv` / `writeTokenEnv` | `OSS_SCOUT_GITHUB_TOKEN` / `OSS_SCOUT_WRITE_TOKEN` | The codespace already uses `GITHUB_TOKEN` for its own token. |
| `interests.languages` | TypeScript, JavaScript, Python | Java is left out because Maven and Gradle images and builds cost storage and hours on 2 cores. Add `"Java"` and the `spring-boot` topic back if you want them. |
| `screening.maxStars` | 25000 | Skips very large repositories, which have big clones and long test suites. |
| `implementation.model`, `followup.model` | `opencode/big-pickle` | A free opencode Zen model; no account or key needed. |
| `critic.model` | `opencode/nemotron-3-ultra-free` | A free model from a different family, so the critic doesn't share the implementer's blind spots. |
| `mode` | `dry-run` | Nothing is written to GitHub. Switch to `queue` once you trust the output. |

* **Free models come and go.** Run `opencode models | grep '^opencode/'` to see what is offered. If
  a model disappears, pick another one.
* **Free models may log prompts.** That only exposes public repository code and your issue choices.
* **Edit `oss-scout.config.codespaces.json`, then restart opencode.** Commit the file if you want your
  changes to outlive the codespace.

## Staying inside the quota

* **Hours.** 60 hours a month is about 2 hours a day. Check your usage at
  <https://github.com/settings/billing>.
* **Storage.** Storage is used by:
  * the container,
  * the sandbox images (Node and Python share most of their layers),
  * task workspaces, which are pruned after 7 days.

  `df -h /workspaces` and `docker system df` show the current use. `docker image prune -a` frees the
  images; they are pulled again when needed.
* **Keep only one codespace.** Every codespace counts storage, including stopped ones.

## Updates, rebuilds and backups

* **Update oss-scout.** Run `git pull && bun install`, then restart opencode.
* **Change versions.** Edit `BUN_VERSION` or `OPENCODE_VERSION` in `.devcontainer/setup.sh`, then
  rebuild the container. 2.0.24 is the opencode version oss-scout was checked against.
* **Rebuild.** *Codespaces: Rebuild Container* in the command palette keeps `/workspaces` (the
  checkout and the state) and runs `setup.sh` again. Everything else in the container is recreated.
* **Back up the state** before you delete a codespace, or if you won't open it for 30 days:

  ```bash
  tar czf ~/oss-scout-state.tgz -C /workspaces .oss-scout
  ```

  Then download the file from the Explorer (right-click → Download).

## Safety in a codespace

The [safety model](../README.md#safety-model) is unchanged. These points are specific to Codespaces:

* **Tokens are Codespaces secrets.** GitHub stores them encrypted and passes them in as environment
  variables. They are never written to the repository or to the config file.
* **oss-scout never uses the codespace's own `GITHUB_TOKEN`.** That token can push to your oss-scout
  repository.
* **Repository code runs only in containers inside the codespace**, with no network while tests run.
  Only you can open the codespace.
* **Approvals still need you.** Approve with `/oss-approve`, or with the CLI in an interactive
  terminal where you type the repository name.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `[FAIL] github.tokenEnv is GITHUB_TOKEN` | The preset isn't loaded. `echo $OSS_SCOUT_CONFIG` should print the preset's path. If it doesn't, rebuild the container. |
| `[FAIL] OSS_SCOUT_GITHUB_TOKEN is not set` | The secret is missing, isn't shared with this repository, or was added after the codespace started. Restart the codespace. |
| `Sandbox unavailable` | Run `docker info`. If the Docker daemon isn't running, rebuild the container. |
| `bun: command not found` | Run `bash .devcontainer/setup.sh`. |
| `[WARN] State dir … is outside /workspaces` | Set `"stateDir": "/workspaces/.oss-scout"` in the config. |
