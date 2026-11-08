// Elapsed recording time for the menu bar and the REC pill: "4:07", or "1:02:09" past an hour.
public enum Elapsed {
    public static func format(_ seconds: Int) -> String {
        let s = max(0, seconds)
        return s >= 3600 ? "\(s / 3600):" + pad(s / 60 % 60) + ":" + pad(s % 60) : "\(s / 60):" + pad(s % 60)
    }
    private static func pad(_ n: Int) -> String { n < 10 ? "0\(n)" : "\(n)" }
}
