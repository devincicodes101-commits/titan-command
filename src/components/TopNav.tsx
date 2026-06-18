"use client";
import Link from "next/link";
import { signOut } from "next-auth/react";
import { usePathname } from "next/navigation";

interface Props {
  tenantName: string;
  userEmail: string;
}

export default function TopNav({ tenantName, userEmail }: Props) {
  const path = usePathname();

  return (
    <nav style={styles.nav}>
      <div style={styles.brand}>
        <span style={styles.dot} />
        <span style={styles.brandText}>{tenantName}</span>
      </div>
      <div style={styles.links}>
        <Link href="/" style={{ ...styles.link, ...(path === "/" ? styles.active : {}) }}>
          Board
        </Link>
        <Link href="/settings" style={{ ...styles.link, ...(path === "/settings" ? styles.active : {}) }}>
          Settings
        </Link>
        <button
          onClick={() => signOut({ callbackUrl: "/login" })}
          style={styles.signOut}
        >
          Sign Out
        </button>
      </div>
    </nav>
  );
}

const styles: Record<string, React.CSSProperties> = {
  nav: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "14px 32px",
    background: "rgba(14,14,14,.95)",
    borderBottom: "1px solid rgba(164,140,122,.16)",
    position: "sticky",
    top: 0,
    zIndex: 100,
    backdropFilter: "blur(12px)",
  },
  brand: { display: "flex", alignItems: "center", gap: "10px" },
  dot: {
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    background: "var(--tf-orange)",
    boxShadow: "0 0 14px rgba(255,140,0,.7)",
  },
  brandText: {
    fontFamily: "'Space Grotesk', Inter, Arial, sans-serif",
    fontWeight: 900,
    fontSize: "14px",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    color: "var(--tf-text)",
  },
  links: { display: "flex", alignItems: "center", gap: "20px" },
  link: {
    fontFamily: "'Space Grotesk', Inter, Arial, sans-serif",
    fontWeight: 700,
    fontSize: "12px",
    textTransform: "uppercase",
    letterSpacing: "0.1em",
    color: "var(--tf-muted)",
    textDecoration: "none",
  },
  active: { color: "var(--tf-orange)" },
  signOut: {
    background: "transparent",
    border: "1px solid rgba(164,140,122,.3)",
    color: "var(--tf-muted)",
    fontFamily: "'Space Grotesk', Inter, Arial, sans-serif",
    fontWeight: 700,
    fontSize: "12px",
    textTransform: "uppercase",
    letterSpacing: "0.1em",
    padding: "6px 14px",
    cursor: "pointer",
    borderRadius: "3px",
  },
};