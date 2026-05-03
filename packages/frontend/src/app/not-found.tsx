import Link from 'next/link';

export default function NotFound() {
  return (
    <div
      style={{
        minHeight: '60vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
      }}
    >
      <div
        style={{
          maxWidth: 480,
          width: '100%',
          textAlign: 'center',
        }}
      >
        <p
          style={{
            fontSize: 12,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: 'var(--muted-foreground, #6b7280)',
            marginBottom: 8,
          }}
        >
          404
        </p>
        <h1 style={{ fontSize: 24, fontWeight: 600, marginBottom: 8 }}>
          Page not found
        </h1>
        <p
          style={{
            color: 'var(--muted-foreground, #6b7280)',
            marginBottom: 24,
          }}
        >
          The page you were looking for doesn&apos;t exist or has moved.
        </p>
        <Link
          href="/"
          style={{
            display: 'inline-block',
            padding: '8px 14px',
            borderRadius: 8,
            background: 'var(--brand, #2563eb)',
            color: '#fff',
            fontWeight: 500,
            textDecoration: 'none',
          }}
        >
          Go to dashboard
        </Link>
      </div>
    </div>
  );
}
