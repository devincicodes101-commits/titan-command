import CommandBoard from "@/components/CommandBoard";

// Public demo page — no auth required, no database needed.
// Remove this file before going to production with real clients.
export default function DemoPage() {
  return (
    <>
      <div style={{
        background: "#ff8c00",
        color: "#2f1500",
        textAlign: "center",
        padding: "10px",
        fontFamily: "'Space Grotesk', Inter, Arial, sans-serif",
        fontWeight: 900,
        fontSize: "13px",
        letterSpacing: "0.1em",
        textTransform: "uppercase",
      }}>
        Demo Mode — This is a preview. No data is saved.
      </div>
      <CommandBoard savedGoals={null} />
    </>
  );
}