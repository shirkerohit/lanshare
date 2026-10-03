# Spec Delta

## Purpose

Defines the security and privacy boundary of LanShare: that peer-supplied data cannot execute as code or break out of its context, that no file leaves a device without explicit confirmation, that a confidential message reaches only its recipient, and that these boundaries and their limits are documented rather than assumed.

## ADDED Requirements

### Requirement: Peer-supplied values are never executable

Any value originating from another device SHALL be rendered as text and never as markup or executable content, in every surface where peer data is displayed.

#### Scenario: Hostile device type value

- **WHEN** a peer registers with a device type containing markup and script
- **THEN** the value is displayed literally
- **AND** nothing in it executes
- **AND** no script runs in the listing device

#### Scenario: Hostile device name

- **WHEN** a peer registers with a name containing markup and script
- **THEN** the name is displayed literally
- **AND** nothing in it executes

#### Scenario: Hostile message content

- **WHEN** a chat message contains markup, script, or formatting-like sequences
- **THEN** the content is displayed as the user typed it
- **AND** nothing in it executes
- **AND** intended formatting still renders

#### Scenario: Hostile value in every peer surface

- **WHEN** a peer-supplied value appears in any device list, card, chat surface, notification, or saved-device list
- **THEN** it is rendered as text
- **AND** the same treatment is applied in every such surface

### Requirement: Confirmation is required before any file leaves

No file content SHALL begin transmission until the sending user has explicitly confirmed that specific transfer. Confirmation SHALL be required for every transfer, with no remembered approval.

#### Scenario: Confirmation precedes transmission

- **WHEN** a user selects a file to send to a device
- **THEN** a confirmation identifying the file and the destination device is shown
- **AND** no file content is transmitted until the user confirms
- **AND** declining sends nothing

#### Scenario: Every transfer is confirmed

- **WHEN** the same user sends to the same device again, or sends multiple files
- **THEN** each transfer is confirmed separately
- **AND** approval from an earlier transfer does not carry over

#### Scenario: Confirmation identifies the destination

- **WHEN** a confirmation is shown
- **THEN** it names the receiving device
- **AND** it names the file or files
- **AND** it cannot be satisfied by a gesture that occurred before it appeared

### Requirement: Incoming transfers are confirmed

A received file SHALL be surfaced to the receiving user for confirmation before it is delivered or saved, and SHALL be identifiable by the sending device.

#### Scenario: Incoming file requires confirmation

- **WHEN** a file arrives from a paired device
- **THEN** the receiving user sees the sender and the file details
- **AND** the file is delivered or saved only after confirmation

#### Scenario: Declined incoming transfer

- **WHEN** the receiving user declines
- **THEN** the file is not saved
- **AND** no partial artifact remains
- **AND** the sender is informed the transfer was declined

### Requirement: Confidential messages reach only their recipient

A message marked confidential SHALL be delivered only to its intended recipient and to no other device, and SHALL NOT be transmitted to peers who are not the recipient.

#### Scenario: Confidential message delivery

- **WHEN** a user sends a message marked confidential to a specific device
- **THEN** only that device receives it
- **AND** no other device in the same network receives it
- **AND** no device on any other network receives it

#### Scenario: Confidential message is not broadcast

- **WHEN** a confidential message is sent
- **THEN** no group delivery occurs
- **AND** the message content does not appear in any other device's message history

#### Scenario: Undeliverable confidential message

- **WHEN** a confidential message cannot be delivered to its recipient
- **THEN** the sender is informed it was not delivered
- **AND** it is not delivered to any other device as a fallback

#### Scenario: Group message remains group

- **WHEN** a user sends a message that is not marked confidential
- **THEN** all devices in the user's network receive it
- **AND** it is visibly distinguishable from a confidential message

### Requirement: Static file serving is confined to the served directory

The application server SHALL serve only files within its intended content directory and SHALL reject any request resolving outside it.

#### Scenario: Traversal attempt is refused

- **WHEN** a request contains path segments that resolve outside the served directory
- **THEN** no file is served
- **AND** the refusal does not reveal whether the target exists

#### Scenario: Nested legitimate path is served

- **WHEN** a request resolves to a file inside the served directory through nested segments
- **THEN** the file is served normally

#### Scenario: Both servers enforce the same rule

- **WHEN** either bundled server is used
- **THEN** the traversal rule is enforced identically
- **AND** the behaviour does not depend on which server is running

### Requirement: Malformed peer input is rejected

Metadata supplied by a peer SHALL be validated before it is accepted into any visible or retained state, and oversized or malformed values SHALL be refused rather than truncated.

#### Scenario: Missing required metadata

- **WHEN** a peer registers without a name or identifier
- **THEN** the registration is refused
- **AND** the application remains fully functional

#### Scenario: Oversized metadata

- **WHEN** a peer registers with an excessively long name or oversized payload
- **THEN** it is refused
- **AND** no partial value is displayed or stored
- **AND** the application remains fully functional

#### Scenario: Malformed message structure

- **WHEN** a peer sends a message whose structure is invalid
- **THEN** it is discarded
- **AND** existing connections and transfers are unaffected

### Requirement: Server operation is legible at startup

When the signaling server starts, it SHALL report the addresses on which it is reachable so that an operator can share them without inspecting the source.

#### Scenario: Startup reports reachable addresses

- **WHEN** the server starts
- **THEN** it prints the addresses a user can open
- **AND** it states which hosting mode is active

#### Scenario: No reachable network address

- **WHEN** the host has no non-loopback network address
- **THEN** the server reports that fact instead of printing an unusable address

### Requirement: The security boundary is documented

The application SHALL document what each party can observe in each hosting mode, which metadata crosses the signaling server, and which boundaries are enforced by the application rather than by the network.

#### Scenario: Documented per-mode observability

- **WHEN** the documentation is read
- **THEN** it states what a self-hosted deployment can observe
- **AND** what a hosted relay can observe
- **AND** that file contents cross neither

#### Scenario: Documented enforcement boundary

- **WHEN** the documentation is read
- **THEN** it states that network isolation is enforced by application logic and not by the network
- **AND** it states the granularity used to group devices and its limitations
- **AND** it states that no short numeric pairing code is offered, and why