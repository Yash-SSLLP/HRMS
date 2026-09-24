// Standardised SmartHR-style page header: a title, an optional subtitle, and an
// optional actions slot on the right (buttons, filters, etc.).
//
// THE ACTIONS STAY ON THE RIGHT. The title block used to be sized by its text,
// so on a 13" laptop — where the fixed sidebar leaves ~1000px of page — a long
// subtitle made that block the full width and the buttons dropped to a line of
// their own at the LEFT. Now the title block takes whatever the actions leave
// (`grow`, wrapping its own text) and only gives way below 18rem, and the
// actions carry `ml-auto`, so even when there is truly no room for both on one
// line — a phone — they wrap to the right, not to the left.
export default function PageHeader({ title, subtitle, children }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
      <div className="min-w-0 grow basis-72">
        <h1 className="text-2xl font-semibold text-gray-900">{title}</h1>
        {subtitle && <p className="text-sm text-gray-500 mt-0.5">{subtitle}</p>}
      </div>
      {children && <div className="ml-auto flex flex-wrap items-center justify-end gap-2">{children}</div>}
    </div>
  );
}
