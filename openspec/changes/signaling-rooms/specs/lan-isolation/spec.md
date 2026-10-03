# Spec Delta

## Purpose

Guarantees that peers connected to a LanShare signaling server can only discover and connect to devices on their own local network, and that a connection between two devices is established only after both sides have explicitly agreed to it.

## ADDED Requirements

### Requirement: Peers are partitioned by local network

The signaling server SHALL assign each connected peer to a scope derived from the local network the connection originates from, and SHALL only ever introduce peers to others in the same scope. A peer SHALL receive no information about the existence, count, or identity of peers in any other scope.

#### Scenario: Peers on different networks are mutually invisible

- **WHEN** two devices connect to the signaling server from different local networks
- **THEN** neither device's peer list contains the other device
- **AND** neither device receives any join, leave, or signal message about the other
- **AND** no connection between them is attempted

#### Scenario: Peers on the same network discover each other

- **WHEN** two devices connect to the signaling server from the same local network
- **THEN** each is listed in the other's device list
- **AND** the list appears without the user exchanging any code or link

#### Scenario: Many users on different networks share one server

- **WHEN** many users across many distinct local networks connect to one signaling server
- **THEN** each user sees only the devices on their own local network
- **AND** the presence of peers in other scopes does not alter any user's device count or list

#### Scenario: Isolation holds under adversarial registration

- **WHEN** a peer supplies a forged or malformed network address
- **THEN** the server assigns it a scope that grants it no peers
- **AND** it cannot influence the scope assignment of any other peer

### Requirement: Cross-scope signaling is refused

The signaling server SHALL refuse to relay any signal between peers in different scopes, and SHALL treat such an attempt as a violation rather than routing it.

#### Scenario: Direct cross-scope relay attempt

- **WHEN** a peer sends a signal naming a target peer in a different scope
- **THEN** the signal is not delivered
- **AND** the refusal is recorded for the offending peer
- **AND** no connection state changes as a result

### Requirement: Connection requires mutual agreement

Two devices SHALL establish a connection only after one device has sent a pairing request and the other has explicitly accepted it. No connection SHALL be established by unilateral action or by mutual discovery alone.

#### Scenario: Request is accepted

- **WHEN** device A requests to pair with device B and device B accepts
- **THEN** exactly one side initiates the connection handshake
- **AND** a direct channel opens between them
- **AND** both devices show the other as connected

#### Scenario: Request is declined

- **WHEN** device A requests to pair with device B and device B declines
- **THEN** no connection handshake begins
- **AND** device A is informed the request was declined
- **AND** the two devices remain unconnected

#### Scenario: Request is ignored

- **WHEN** device A requests to pair with device B and device B does not respond
- **THEN** the request expires
- **AND** no connection is established
- **AND** device A is informed the request timed out

#### Scenario: Device appearing does not auto-connect

- **WHEN** a new device appears in a device's list
- **THEN** no connection handshake begins
- **AND** connection setup is possible only after a request and acceptance

### Requirement: Exactly one side initiates

For any accepted pairing, exactly one device initiates the connection handshake and the other responds. The system SHALL NOT have both devices initiate simultaneously.

#### Scenario: Simultaneous mutual requests do not collide

- **WHEN** devices A and B send pairing requests to each other at the same time
- **THEN** the connection still establishes successfully
- **AND** exactly one side acts as initiator
- **AND** the resulting channel is not torn down by a handshake collision

#### Scenario: Repeated pairing with an already-connected device

- **WHEN** a user requests to pair with a device that is already connected
- **THEN** the existing connection is preserved
- **AND** no duplicate connection is created

### Requirement: Stale peers are removed

The signaling server SHALL detect peers whose connection has lapsed and SHALL remove them from peer lists, so that unavailable devices do not accumulate or block new pairings.

#### Scenario: Abruptly disconnected peer

- **WHEN** a peer's connection drops without a clean close
- **THEN** that peer is removed from other peers' device lists within a bounded time
- **AND** other peers are informed it left
- **AND** no ghost entry remains

#### Scenario: Reconnecting peer does not delete its successor

- **WHEN** a peer reconnects and re-registers before its previous connection's close is processed
- **THEN** the newly registered peer remains present
- **AND** the stale close does not remove the live peer
- **AND** other peers are not incorrectly told it left

### Requirement: Signaling loss does not tear down a working link

A peer whose signaling connection lapses SHALL retain an already-established direct data channel with peers it is still connected to. Only the signaling channel is affected.

#### Scenario: Signaling blip with healthy data channel

- **WHEN** a peer's signaling connection drops while its direct data channel to another peer remains functional
- **THEN** the direct channel stays open
- **AND** file transfers over it continue
- **AND** the peer reconnects its signaling connection and reappears without disturbing the surviving link

### Requirement: Manual mode recovery

When no signaling server is available, a failed connection attempt SHALL be recoverable rather than looping indefinitely against a channel that can never be answered.

#### Scenario: Connection fails with no signaling available

- **WHEN** a connection attempt fails and no signaling server is reachable
- **THEN** the system stops retrying after a bounded number of attempts
- **AND** reports that re-pairing is required
- **AND** creates no accumulating abandoned connection attempts

### Requirement: Signaling endpoint is configurable

The client SHALL obtain its signaling endpoint from configuration, allowing the same build to run against a self-hosted server, a hosted relay, or no server at all, without code changes.

#### Scenario: Default endpoint used when unconfigured

- **WHEN** no signaling endpoint is configured
- **THEN** the client falls back to the endpoint served alongside the application

#### Scenario: Endpoint disabled entirely

- **WHEN** configuration specifies that no signaling server is used
- **THEN** the client presents manual pairing
- **AND** makes no signaling connection attempts

#### Scenario: Configured hosted relay

- **WHEN** a hosted relay endpoint is configured
- **THEN** the client connects to that relay instead of the default
- **AND** discovery and pairing work as they do in the self-hosted case

### Requirement: File contents never traverse the signaling server

No file content SHALL be transmitted through a signaling server in any hosting mode.

#### Scenario: Full transfer with server present

- **WHEN** a file is transferred between two devices with a signaling server running
- **THEN** the signaling server observes only connection metadata
- **AND** no file content is observed by it
- **AND** the transfer proceeds directly between the two devices