## Releases

# Version 0.3.0 (2019-12-31)

- Force retry syncing if there is an error that isn't caused by the client
  disconnecting.
- Ensure the interval for updating the fee information is cleared after funds
  have been transferred, saving bandwidth.
- Auto updater support has been added.
- A custom defined menu is now implemented, this allows for manually checking
  for updates.
- Update to the latest network protocol which directly supports ping/pong.

### Breaking changes

- Previous wallet versions will no longer be able to properly communicate to the
  network.

# Version 0.2.1 (2019-12-03)

This release improves the synchronization mechanism reliability and performance
in some cases.

- Print out current height every 5 seconds to console rather than every 10000
  blocks during primary synchronization.
- Update the database current sync height more often while synchronizing. This
  will minimize the chances of mistakenly seeing a transaction twice and to
  ensure a restart of the wallet will not restart synchronization from its
  initial state.

# Version 0.2.0 (2019-11-29)

This release updates to the latest network protocol and utilizes the more
efficient GetBlockRange API for synchronizing blocks.

- Use the GetBlockRange API to avoid network round trips when synchronizing.

### Breaking changes

- Previous wallet versions will no longer be able to properly communicate to the
  network.

# Version 0.1.0 (2019-11-14)

This marks the first release of the project. Basic features include
sending/receiving transactions, viewing existing transactions, restoring an
existing key, and backup their private key.
