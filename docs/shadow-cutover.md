# Shadow cutover checklist

Follow these operator steps to switch a shadow installation to primary.

1. Through primary, identify existing trigger specs tagged `shadow` using the
   helper's role-bearing trigger listing. Pause/delete their Hermes jobs and
   delete their helper folders. Recreate wanted triggers after cutover from
   primary. Do not rely on the old shared `signalbox_mail_trigger.py` gate to honour spec roles.
2. Stop Wayroost before changing its config or unit. Save the shadow config
   and the server and Safety unit overrides for rollback. Set the Wayroost config
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

   Clear any legacy shadow role overrides as well. Separately, the shipped
   `wayroost-paseo-safety.service` retains its own `WAYROOST_ROLE=shadow`
   override until explicitly changed. Set it to primary for startup/timer
   reconciliation at cutover; its `StateDirectory=wayroost-paseo-safety`
   remains separate. Safety status reads never reconcile in either role.
   Run `systemctl daemon-reload` after both unit changes, then restart the
   Safety helper and Wayroost. The shadow-owned
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
   startup role and role source. Check helper health acknowledges the role.
   New primary mail triggers use `wayroost_mail_trigger.py`.
5. Move the tunnel to Wayroost, stop the legacy app (`signalbox`) while
   keeping it installed, and pair the phone.

For rollback, set the config and unit environment back to shadow, restore the
dedicated shadow state directory (`/var/lib/wayroost-shadow` by default).
Restore the server unit's `StateDirectory=wayroost-shadow` (reset the directive
first in a drop-in), and the Safety companion's separate
`WAYROOST_ROLE=shadow` override. With both stopped, reload the units and restart
the Safety helper and Wayroost, then restore the legacy app (`signalbox`) and its tunnel.
Do not activate shadow-tagged trigger specs by bulk editing their role.
