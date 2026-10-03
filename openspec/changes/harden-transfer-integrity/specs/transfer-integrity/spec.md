# Spec Delta

## Purpose

Guarantees that a file received through LanShare is byte-for-byte identical to the file sent, that concurrent transfers between the same two devices cannot interfere with each other, and that a transfer which cannot be completed is reported as a failure rather than delivered as a short or corrupted file.

## ADDED Requirements

### Requirement: Chunk self-description

Every chunk transmitted between peers SHALL carry its own transfer identifier, sequence number, and payload length, such that the receiver can route it without relying on arrival order or on any prior out-of-band message.

#### Scenario: Two transfers to the same device proceed independently

- **WHEN** a user selects three files at once and sends them to one peer
- **THEN** each chunk is routed by its own transfer identifier and sequence number
- **AND** each received file contains exactly the bytes of the file it was sent from
- **AND** the order in which chunks from the three transfers arrive on the channel is irrelevant

#### Scenario: Metadata and payload cannot be misassociated

- **WHEN** chunk payloads from two concurrent transfers interleave on the same data channel
- **THEN** each payload is delivered to the transfer named in its own envelope
- **AND** no chunk is attributed to a transfer that did not send it

### Requirement: Completion is verified before delivery

The system SHALL verify that all announced chunks were received and that the assembled content matches the sender's announced cryptographic digest, and SHALL withhold a completed file from the user until both checks pass.

#### Scenario: Complete transfer is delivered

- **WHEN** every announced chunk has been received and the digest matches
- **THEN** the system presents the file to the user as complete
- **AND** reports the byte count and digest as verified

#### Scenario: Missing chunk fails the transfer

- **WHEN** a transfer completes with one or more chunks absent
- **THEN** the system does not present the file as complete
- **AND** reports which sequence numbers were missing
- **AND** offers to request retransmission of exactly those chunks

#### Scenario: Digest mismatch fails the transfer

- **WHEN** all chunks were received but the assembled content does not match the announced digest
- **THEN** the system does not present the file to the user
- **AND** reports the file as corrupt
- **AND** does not leave a retrievable copy of the corrupt content available

### Requirement: Missing chunks are recoverable

The receiver SHALL be able to request retransmission of specific missing chunks, and the sender SHALL resend those chunks idempotently without restarting the transfer.

#### Scenario: Transient loss is repaired without restarting

- **WHEN** a receiver detects one or more missing sequence numbers and requests them
- **THEN** the sender resends exactly the requested chunks from the original file content
- **AND** the transfer completes and passes verification
- **AND** no chunk that was already received correctly is resent

#### Scenario: Retry is bounded and reported

- **WHEN** a chunk cannot be recovered after the configured retry limit
- **THEN** the system reports the transfer as failed
- **AND** names the chunks that could not be recovered
- **AND** does not deliver a partial file

### Requirement: Large transfers use bounded memory

The system SHALL stream incoming chunk content to storage as it arrives rather than retaining the entire file in memory, and SHALL fall back to in-memory assembly when streaming is unavailable.

#### Scenario: Large file transfer does not scale memory with file size

- **WHEN** a device receives a file substantially larger than available free memory
- **THEN** the system writes chunk content to storage incrementally
- **AND** memory usage remains proportional to the chunk size rather than the file size

#### Scenario: Unsupported storage falls back cleanly

- **WHEN** the browser does not provide direct-to-disk writing
- **THEN** the system assembles the file in memory
- **AND** still performs full digest verification before presenting it
- **AND** reports reduced capability for files that cannot be held in memory

### Requirement: Channel loss does not terminate a transfer

The transfer data channel SHALL retry lost messages indefinitely rather than closing after a fixed number of losses, so that recoverable loss cannot escalate into a dead channel mid-transfer.

#### Scenario: Sustained loss under the old limit

- **WHEN** more messages are lost than a fixed small retry limit during one transfer
- **THEN** the channel remains open
- **AND** the transfer continues or completes via retransmission

### Requirement: Progress reflects real throughput

Transfer speed and aggregate bandwidth readouts SHALL report throughput measured over the current interval, and SHALL be consistent with the bytes actually delivered.

#### Scenario: Reported speed matches observed transfer rate

- **WHEN** a transfer runs at a steady rate for several intervals
- **THEN** the reported speed remains close to the actual delivered byte rate
- **AND** does not grow as the transfer progresses

#### Scenario: Aggregate bandwidth reflects sum of active transfers

- **WHEN** two transfers run concurrently in opposite directions
- **THEN** the aggregate upload and download readouts reflect the sum of bytes actually sent and received in the current interval

### Requirement: Incompatible peers are rejected rather than corrupting data

The system SHALL detect a peer that does not speak the current transfer protocol and SHALL refuse to transfer to it with a clear protocol-mismatch message.

#### Scenario: Mixed-version peers cannot corrupt each other

- **WHEN** a user on the current build attempts to send a file to a peer running an older protocol
- **THEN** the system reports a protocol mismatch and names the peer's version
- **AND** no transfer is started
- **AND** no partially written or corrupt file is produced on either side

### Requirement: Topology view renders with only the local device

The network topology view SHALL render correctly for every number of connected devices, including the case where the local device is the only node.

#### Scenario: First run before any peer joins

- **WHEN** a user opens the app and no other device is connected
- **THEN** the topology view renders the local node at a valid position
- **AND** no node is positioned at an undefined coordinate

#### Scenario: Each peer joins

- **WHEN** a first, then second, then third peer connects
- **THEN** every node is placed at a distinct, valid position
- **AND** all nodes remain visible and correctly labelled