import Foundation
import Translation

@MainActor
final class TranslationCoordinator: ObservableObject {
    @Published private(set) var configuration: TranslationSession.Configuration?
    @Published private(set) var lastErrorMessage: String?
    @Published private(set) var didPrepareLanguages = false

    private(set) var pendingJob: TranslationJob?
    private let sourceLanguage = Locale.Language(identifier: "en")
    private let targetLanguage = Locale.Language(identifier: "he")

    func ensureConfiguration() {
        if configuration == nil {
            configuration = TranslationSession.Configuration(
                source: sourceLanguage,
                target: targetLanguage
            )
        }
    }

    func queue(job: TranslationJob) {
        pendingJob = job
        ensureConfiguration()

        guard var configuration else { return }
        configuration.invalidate()
        self.configuration = configuration
    }

    func checkLanguageSupport() async -> Bool {
        let availability = LanguageAvailability()
        let status = await availability.status(from: sourceLanguage, to: targetLanguage)

        switch status {
        case .installed, .supported:
            return true
        case .unsupported:
            return false
        @unknown default:
            return false
        }
    }

    func prepareIfNeeded(using session: TranslationSession) async throws {
        guard !didPrepareLanguages else { return }
        try await session.prepareTranslation()
        didPrepareLanguages = true
    }

    func performPendingTranslation(using session: TranslationSession) async -> TranslationResolution? {
        guard let job = pendingJob else { return nil }

        do {
            try await prepareIfNeeded(using: session)
            let response = try await session.translate(job.englishText)
            lastErrorMessage = nil
            return TranslationResolution(job: job, hebrewText: response.targetText)
        } catch {
            lastErrorMessage = error.localizedDescription
            return nil
        }
    }
}
