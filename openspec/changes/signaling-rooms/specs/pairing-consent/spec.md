# Spec Delta

## Purpose

Defines how two devices agree to connect before a direct channel is established, so that connection setup is an explicit, mutual, single-initiator action rather than something that happens automatically on discovery.

## ADDED Requirements

### Requirement: Pairing request identifies both devices

A pairing request SHALL name the requesting device with enough information for the recipient to identify it, and SHALL be deliverable only to the intended recipient.

#### Scenario: Recipient sees who is asking

- **WHEN** a pairing request is received
- **THEN** the recipient sees the requesting device's name and type
- **AND** is offered the choice to accept or decline

#### Scenario: Request reaches only the target

- **WHEN** a pairing request is sent
- **THEN** no other device in the scope receives it
- **AND** it is not visible to peers in other scopes

#### Scenario: Request to an absent device

- **WHEN** a pairing request names a device that is not connected
- **THEN** the request fails
- **AND** the requester is informed the device is unavailable

### Requirement: Requester waits for a decision

A device that sends a pairing request SHALL wait for an explicit accept or decline before any connection handshake begins, and SHALL show the request as pending.

#### Scenario: Pending state is visible

- **WHEN** a request has been sent and not yet answered
- **THEN** the requester sees that it is waiting
- **AND** no connection attempt is visible as in progress

#### Scenario: Outcome is reported

- **WHEN** a request is accepted or declined
- **THEN** the requester is informed of the outcome
- **AND** the pending state is cleared

### Requirement: Connection is established after acceptance only

A direct channel SHALL be established between two devices only after an acceptance, and the channel SHALL be opened by exactly one device acting as initiator.

#### Scenario: Accepted request produces a working channel

- **WHEN** a request is accepted
- **THEN** one device sends a connection offer
- **AND** the other responds with an answer
- **AND** a direct channel opens between them
- **AND** files can be transferred over it

#### Scenario: No channel without acceptance

- **WHEN** a request has not been accepted
- **THEN** no direct channel exists between the devices
- **AND** no file can be transferred between them

### Requirement: Request does not persist indefinitely

A pairing request that receives no response SHALL expire within a bounded time and leave no state behind.

#### Scenario: Unanswered request expires

- **WHEN** no response arrives within the request's lifetime
- **THEN** the request is discarded on both devices
- **AND** neither device shows it as pending
- **AND** no connection is established later from the stale request

### Requirement: Handshake does not collide

Concurrent or reciprocal pairing activity SHALL NOT prevent a channel from opening. Where both sides would otherwise initiate, the system SHALL resolve to a single initiator.

#### Scenario: Both devices request at once

- **WHEN** A and B send requests to each other simultaneously and both accept
- **THEN** a channel opens successfully
- **AND** only one device initiated the handshake
- **AND** the channel is not subsequently torn down

#### Scenario: Duplicate request to an existing connection

- **WHEN** a pairing request is accepted for a device already connected
- **THEN** the existing channel continues to serve
- **AND** no second channel to the same device is created

#### Scenario: Repeated requests after acceptance

- **WHEN** a pairing request is accepted more than once for the same pair
- **THEN** the outcome is stable
- **AND** the devices end in a single connected state

### Requirement: Connection failure is recoverable and reported

When a connection attempt after acceptance fails, the system SHALL report the failure, SHALL retry a bounded number of times, and SHALL then state that re-pairing is needed.

#### Scenario: Failure after acceptance

- **WHEN** a channel fails to open after a request was accepted
- **THEN** the failure is shown to both devices
- **AND** retries occur a bounded number of times
- **AND** the system then reports that pairing must be redone
- **AND** no abandoned connection attempts accumulate

#### Scenario: Recovery after a later successful retry

- **WHEN** a retry succeeds
- **THEN** the devices show as connected
- **AND** no stale failure state remains visible