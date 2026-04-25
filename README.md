# DriveTranslate

`DriveTranslate` is a native iPhone SwiftUI prototype for live ambient-audio transcription and translation.

## MVP scope

- Listen through the iPhone microphone while spoken English audio plays in the environment.
- Transcribe English speech live.
- Translate the current English transcript to Hebrew.
- Show two live tabs:
  - `Hebrew`: live Hebrew translation plus recent Hebrew lines.
  - `English`: live English transcription plus recent English lines.
- Keep a lightweight rolling history of finalized transcript pairs on-device.

## Current implementation

This repository contains a hand-scaffolded Xcode project and the initial app architecture:

- SwiftUI app shell with Hebrew and English tabs
- Shared `SessionStore` for live state
- Apple Speech framework microphone transcription service
- Translation bridge built around SwiftUI's `translationTask`
- Setup screen for permissions and translation-preparation guidance
- Mock transcript mode for simulator-style UI and state testing

## Important notes

- This app is designed for a real iPhone, not the simulator.
- This workspace does not have Xcode or Apple SDK tooling, so the code was scaffolded but not compiled here.
- The Speech and Translation APIs used here depend on device support, iOS version, and installed translation assets.

## Mock mode

- The app automatically uses `Mock transcript` mode when it runs in the iOS Simulator.
- On a real device, you can force the same behavior by adding the launch argument `--mock-mode` to the app scheme in Xcode.
- Mock mode simulates incoming English transcript lines and uses a lightweight fake Hebrew translation so the Hebrew and English screens can be tested without live microphone input.
