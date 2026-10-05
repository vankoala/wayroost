# Shadow cutover checklist

Follow these operator steps to switch a shadow installation to primary.

The earlier Cloud agents, Safety commands and Worker approvals routes use their
existing writers by default (`settings.legacyRoutesViaPipeline: false`).
Supervisor capabilities never change that choice. The server reads this setting
once at startup; with `true`, all three routes use only the settings pipeline,
including when pipeline writes are unavailable. The pipeline refuses changes
and undo for these settings while the switch is `false`.

Before deliberately enabling this switch, stop Wayroost and the existing writers.
Carry the current Cloud agents and Worker approvals choices into the pipeline's
Paseo configuration, preserving their effective provider policies. Copy the
current `enabled` value from `hermes-safety-commands.json` into
`safetyCommandsEnabled` in the shared Wayroost settings, preserving notification
fields. This is a one-time operator action: startup never copies or
reconciles either store. Verify the supervisor's config verbs and writes, then
set `settings.legacyRoutesViaPipeline` to `true` and restart Wayroost. Before
rolling back to `false`, stop the writers and carry the current pipeline choices
back into the existing stores so the deliberate restart retains those choices.

1. Through primary, identify existing trigger specs tagged `shadow` using the
   helper's role-bearing trigger listing. Pause/delete their Hermes jobs and
   delete their helper folders. Recreate wanted triggers after cutover from
   primary. Do not rely on the old shared `signalbox_mail_trigger.py` gate to honour spec roles.
2. Stop Wayroost before changing its config or unit. Save the shadow config
   and the server unit overrides for rollback. Set the Wayroost config
   role to `primary` **and clear the unit's
   `WAYROOST_ROLE=shadow` (or legacy `SIGNALBOX_ROLE=shadow`) override**. Both
   sources must allow primary; an environment value of primary cannot widen
   a shadow config. Keep the dedicated listener and choose a separate
   primary state directory (`/var/lib/wayroost` by default). In the server unit,
   replace `StateDirectory=wayroost-shadow` with `StateDirectory=wayroost`
   (a drop-in must first reset `StateDirectory=`). `DynamicUser=yes` and
   `ProtectSystem=strict` remain: systemd's StateDirectory creates and grants
   access to that exact path. Config `stateDir` and the unit must match.
   For the default primary directory, the server drop-in is:

   ```ini
   [Service]
   Environment=WAYROOST_ROLE=primary
   StateDirectory=
   StateDirectory=wayroost
   ```

   Clear any legacy shadow role overrides as well. The owner-side Safety helper
   is never installed: leave `SAFETY_OWNER` unset when installing the server.
   The supervisor's catalogue operations `paseo.worker-approvals` and
   `paseo.provider-enabled` replace it. Enable and verify the supervisor's
   config verbs before cutover; launcher actions remain off until the launchers
   and their paths are protected. Once the supervisor advertises those verbs and
   its `configWrites` switch is on, enable `settings.legacyRoutesViaPipeline` so
   settings writes use the supervisor's config verbs. Carry over current values
   explicitly with both writers stopped, as described above; enabling the switch
   never copies them; do not install or start the owner-side Safety helper.
   Keep PC-only writes disabled until the local listener has been verified on
   this PC. Run `systemctl daemon-reload` after the unit changes, then restart
   Wayroost. The shadow-owned
   `.wayroost-role` marker is persistent and cannot be widened by changing config.
   Perform any wanted state migration with both writers stopped; startup
   never copies data or changes ownership.
3. Install the primary runtime and its scoped role config with `install.sh`,
   and update the Hermes plugin with `setup-bridge.sh`. New helper units and
   upgraded existing units name the scoped fallback; new mail gates use their
   explicit primary specs. Scope shadow variables to shadow processes;
   never export them into primary agent shells. Missing/unreadable configs
   keep helper/mail/hook processes shadow.
4. Restart Wayroost and check its
   startup role and role source. Check trigger helper health acknowledges the role.
   Verify the Safety settings through the supervisor's catalogue operations.
   New primary mail triggers use `wayroost_mail_trigger.py`.
5. Move the tunnel to Wayroost, stop the legacy app (`signalbox`) while
   keeping it installed, and pair the phone.

For rollback, set the config and unit environment back to shadow, restore the
dedicated shadow state directory (`/var/lib/wayroost-shadow` by default).
Restore the server unit's `StateDirectory=wayroost-shadow` (reset the directive
first in a drop-in). Disable the supervisor's `configWrites` switch before
rolling back to a supervisor without config verbs. With Wayroost stopped,
reload the units and restart Wayroost, then restore the legacy app (`signalbox`) and its tunnel.
If rolling back the supervisor's config verbs as well, undo settings changes
and turn `configWrites` off before restoring the previous supervisor. Leave
`SAFETY_OWNER` unset; rollback never installs the Safety helper.
Do not activate shadow-tagged trigger specs by bulk editing their role.
