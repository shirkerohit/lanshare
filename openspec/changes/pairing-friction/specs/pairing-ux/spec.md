# Spec Delta

## Purpose

Ensures that a pairing can be completed by scanning, clicking, or a single keystroke rather than by transcribing a long string, and that both devices confirm the pairing refers to the same thing before either relies on it.

## ADDED Requirements

### Requirement: Pairing payload is compact

A pairing payload SHALL be compressed before presentation, and SHALL be expressed in a single-line form containing no padding or line breaks, so that it is short enough to scan as a code and to move by clipboard without reformatting.

#### Scenario: Payload length

- **WHEN** a pairing payload is generated on a device with multiple network interfaces
- **THEN** the payload is substantially shorter than the uncompressed session description
- **AND** is short enough to be rendered as a scannable code
- **AND** contains no line breaks or padding characters

#### Scenario: Round trip preserves the payload

- **WHEN** a generated payload is decoded by the receiving device
- **THEN** the decoded session description is identical to the one that was encoded
- **AND** the connection establishes successfully

#### Scenario: Unusable candidates are excluded

- **WHEN** a payload is generated
- **THEN** candidates on interfaces that cannot be reached are excluded
- **AND** the remaining payload still permits a successful connection on the local network

### Requirement: Pairing payload travels in a link

A pairing payload SHALL be encodable in the fragment of a link, which SHALL NOT be transmitted to the host serving the application. Opening such a link SHALL restore the pairing state on the device that opens it.

#### Scenario: Link opened restores pairing

- **WHEN** a device opens a pairing link
- **THEN** the pairing payload is recovered from the link
- **AND** the device shows what it is being asked to pair with
- **AND** no pairing code needs to be transcribed

#### Scenario: Host does not receive the payload

- **WHEN** a device opens a pairing link
- **THEN** the host serving the application receives a request that contains no pairing payload

#### Scenario: Fragment is not retained in history

- **WHEN** a pairing link has been consumed
- **THEN** the payload is removed from the visible address so it cannot be re-opened accidentally or shared onward

#### Scenario: Offer and answer links are distinguishable

- **WHEN** a device opens a link carrying either an offer or an answer
- **THEN** it handles each as the correct role in the pairing
- **AND** a malformed or unrelated link is rejected with a clear message

### Requirement: Payload is presented in multiple forms

A generated pairing payload SHALL be presented simultaneously as a scannable code, as a clickable link, as a copyable value, and as a grouped human-readable form, all representing the same payload.

#### Scenario: All forms represent one payload

- **WHEN** a payload is generated
- **THEN** the scannable code, the link, and the grouped text each decode to the same payload
- **AND** pairing succeeds using any one of them

#### Scenario: Scan using the device's own camera

- **WHEN** a phone scans the displayed code with its native camera application
- **THEN** the application opens with the pairing state restored
- **AND** no in-page camera permission prompt is required

#### Scenario: Copy to clipboard in one action

- **WHEN** the user activates the copy control
- **THEN** the payload is on the clipboard
- **AND** the user is told it was copied

#### Scenario: Grouped form is legible

- **WHEN** the grouped human-readable form is displayed
- **THEN** it is presented in visually separated groups so that a misread is noticeable
- **AND** it is selectable as text

### Requirement: Receiving a payload takes minimal effort

A device receiving a pairing payload SHALL accept it with a single paste or a single link open, and SHALL process it without the user selecting, copying, or navigating.

#### Scenario: Paste and auto-submit

- **WHEN** a payload is pasted into the pairing input
- **THEN** the input is already focused when the pairing panel opens
- **AND** the payload is processed on paste without a separate submit action

#### Scenario: Either form is accepted

- **WHEN** the input receives either a raw payload or a full link containing one
- **THEN** it is processed identically
- **AND** no manual editing is required

#### Scenario: Invalid input is reported

- **WHEN** an input is neither a valid payload nor a valid link
- **THEN** pairing does not proceed
- **AND** the user is told the input is not a valid pairing code

### Requirement: Pairing is confirmed before trust is established

Both devices SHALL display the same short confirmation code derived from the pairing exchange, and the pairing SHALL NOT be treated as established until the user confirms the codes match.

#### Scenario: Codes match

- **WHEN** both devices show the same confirmation code and the user confirms on one
- **THEN** the pairing completes
- **AND** files can be exchanged

#### Scenario: Codes do not match

- **WHEN** the displayed confirmation codes differ
- **THEN** the mismatch is visible to the user before any file is exchanged
- **AND** pairing is not treated as trusted

#### Scenario: Confirmation is skippable

- **WHEN** the user declines to confirm
- **THEN** the pairing may still proceed
- **AND** the user is recorded as having skipped confirmation

### Requirement: Directional pairing works per device capability

Where one device can scan and the other cannot, the direction that cannot scan SHALL present its payload in copyable and clickable forms, and the direction that can scan SHALL accept it by scanning or by opening the link.

#### Scenario: Scannable device pairs with a non-scannable one

- **WHEN** a device with a camera and a device without one pair
- **THEN** the camera device scans
- **AND** the non-camera device presents its payload as a link and as copyable text
- **AND** pairing completes without the human reading the payload aloud

#### Scenario: Two devices that can both scan

- **WHEN** two devices that can each scan pair
- **THEN** both directions can be completed by scanning
- **AND** no text entry is required

#### Scenario: Two devices that can neither scan

- **WHEN** two devices that cannot scan pair
- **THEN** each payload is presented as a clickable link and as copyable text
- **AND** each device reaches the other by opening the link or pasting
- **AND** the number of manual actions required is the same in both directions

## Non-goals

Short numeric codes and codes read aloud are explicitly out of scope. A code short enough to say or type is far too small to carry the cryptographic material a pairing requires, and no amount of compression changes that. Any future short-code design depends on a rendezvous service, which is a different architecture.