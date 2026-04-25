import SwiftUI

@main
struct DriveTranslateApp: App {
    @StateObject private var sessionStore: SessionStore

    init() {
        let appMode = AppMode.current
        let speechService: SpeechRecognitionServiceProtocol

        switch appMode {
        case .liveMicrophone:
            speechService = AppleSpeechRecognitionService()
        case .mock:
            speechService = MockSpeechRecognitionService()
        }

        _sessionStore = StateObject(
            wrappedValue: SessionStore(
                speechService: speechService,
                translationCoordinator: TranslationCoordinator(),
                appMode: appMode
            )
        )
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(sessionStore)
        }
    }
}
