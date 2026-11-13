import Link from "next/link";
import styles from "./landing-wordmark.module.css";

export function LandingWordmark() {
  return (
    <Link href="/" className={styles.wordmark} aria-label="ChangeGraph home">
      <span className={styles.lettering} aria-hidden="true">
        <span>Change</span>
        <span className={styles.graph}>
          <svg className={styles.graphG} viewBox="0 0 26 26" focusable="false">
            <path
              d="M22 6.8A10.8 10.8 0 1 0 22 19.3V13H14"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="m14 13 4-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
            <circle cx="14" cy="13" r="2" fill="currentColor" />
            <circle cx="18" cy="9" r="1.8" fill="currentColor" />
          </svg>
          <span>raph</span>
        </span>
      </span>
    </Link>
  );
}
