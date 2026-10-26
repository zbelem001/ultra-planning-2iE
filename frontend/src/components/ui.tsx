// Composants de base, d'après DESIGN.md : pilules, cartes givrées, marine et orange.

import { clsx } from 'clsx'
import { Check, ChevronDown, Search, X } from 'lucide-react'
import { createPortal } from 'react-dom'
import {
  forwardRef, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes,
} from 'react'

export const cn = clsx

/* ---------- Bouton ---------- */

type Variant = 'primary' | 'accent' | 'outline' | 'ghost' | 'destructive'
type Size = 'sm' | 'md' | 'lg' | 'icon' | 'icon-sm'

const variants: Record<Variant, string> = {
  primary: 'bg-navy text-white hover:bg-navy-hover shadow-sm',
  accent: 'bg-orange text-navy hover:brightness-105 shadow-sm',
  outline: 'bg-white/80 text-ink border border-line hover:bg-white',
  ghost: 'bg-transparent text-ink hover:bg-muted',
  destructive: 'bg-red-600/10 text-red-700 hover:bg-red-600/15',
}
const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-xs gap-1.5',
  md: 'h-10 px-4 text-sm gap-2',
  lg: 'h-12 px-6 text-sm gap-2',
  icon: 'size-10',
  'icon-sm': 'size-8',
}

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }>(
  function Button({ variant = 'primary', size = 'md', className, type = 'button', ...props }, ref) {
    return (
      <button
        ref={ref}
        type={type}
        className={cn(
          'press inline-flex shrink-0 items-center justify-center rounded-full font-medium whitespace-nowrap',
          'disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-4 [&_svg]:shrink-0',
          variants[variant],
          sizes[size],
          className,
        )}
        {...props}
      />
    )
  },
)

/* ---------- Badge ---------- */

type Tone = 'neutral' | 'navy' | 'orange' | 'success' | 'danger' | 'warning'
const tones: Record<Tone, { bg: string; dot: string }> = {
  neutral: { bg: 'bg-muted text-ink-2', dot: 'bg-ink-2' },
  navy: { bg: 'bg-navy/10 text-navy', dot: 'bg-navy' },
  orange: { bg: 'bg-orange-soft text-[#7C4A03]', dot: 'bg-orange' },
  success: { bg: 'bg-[#DCFCE7] text-[#166534]', dot: 'bg-[#15803D]' },
  danger: { bg: 'bg-[#FEE2E2] text-[#991B1B]', dot: 'bg-[#DC2626]' },
  warning: { bg: 'bg-orange-soft text-[#7C4A03]', dot: 'bg-[#9A5B0B]' },
}

export function Badge({ tone = 'neutral', dot, pulse, children, className }: {
  tone?: Tone; dot?: boolean; pulse?: boolean; children: ReactNode; className?: string
}) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap', tones[tone].bg, className)}>
      {dot && <span className={cn('size-1.5 rounded-full', tones[tone].dot, pulse && 'pulse-dot')} />}
      {children}
    </span>
  )
}

/* ---------- Surfaces ---------- */

export function Card({ className, children, ...rest }: { className?: string; children: ReactNode } & HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('surface', className)} {...rest}>{children}</div>
}

export function SectionTitle({ eyebrow, title, action, className }: { eyebrow?: string; title: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-end justify-between gap-3', className)}>
      <div className="min-w-0">
        {eyebrow && <p className="section-label mb-1">{eyebrow}</p>}
        <h2 className="text-xl font-light tracking-tight text-ink">{title}</h2>
      </div>
      {action}
    </div>
  )
}

/** Titre de page de la console. Par défaut masqué à l'écran (la navigation montre déjà la page
 *  active) mais gardé pour les lecteurs d'écran, seules les actions restant visibles ;
 *  `visible` l'affiche en entier. */
export function PageTitle({ eyebrow, title, children, visible }: { eyebrow?: string; title: string; children?: ReactNode; visible?: boolean }) {
  if (visible) {
    return (
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          {eyebrow && <p className="section-label mb-2">{eyebrow}</p>}
          <h1 className="text-4xl font-light tracking-tight text-ink sm:text-5xl">{title}</h1>
        </div>
        {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
      </div>
    )
  }
  return (
    <>
      <h1 className="sr-only">{title}{eyebrow ? ` · ${eyebrow}` : ''}</h1>
      {children && <div className="flex flex-wrap items-center justify-end gap-2">{children}</div>}
    </>
  )
}

/* ---------- Onglets en pilule ---------- */

export function PillTabs<T extends string>({ value, onChange, items, size = 'md', className, label }: {
  value: T
  onChange: (v: T) => void
  items: { value: T; label: string; icon?: ReactNode }[]
  size?: 'sm' | 'md'
  className?: string
  label?: string
}) {
  return (
    <div role="tablist" aria-label={label} className={cn('inline-flex max-w-full gap-1 overflow-x-auto rounded-full bg-white/70 p-1 ring-1 ring-white scroll-thin', className)}>
      {items.map((it) => {
        const active = it.value === value
        return (
          <button
            key={it.value}
            role="tab"
            type="button"
            aria-selected={active}
            onClick={() => onChange(it.value)}
            className={cn(
              'press inline-flex shrink-0 items-center gap-1.5 rounded-full font-medium [&_svg]:size-4',
              size === 'sm' ? 'h-8 px-3 text-xs' : 'h-9 px-4 text-sm',
              active ? 'bg-navy text-white shadow-sm' : 'text-ink-2 hover:bg-muted hover:text-ink',
            )}
          >
            {it.icon}
            {it.label}
          </button>
        )
      })}
    </div>
  )
}

/* ---------- Champs ---------- */

const fieldBase =
  'h-12 w-full rounded-full border border-white bg-white/80 px-4 text-base text-ink placeholder:text-ink-2/70 outline-none transition focus:ring-2 focus:ring-navy/70 sm:h-11 sm:text-sm'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...p }, ref) {
  return <input ref={ref} className={cn(fieldBase, className)} {...p} />
})

export function Select({ className, children, ...p }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className={cn('relative', className)}>
      <select className={cn(fieldBase, 'appearance-none pr-10')} {...p}>{children}</select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-4 size-4 -translate-y-1/2 text-ink-2" />
    </div>
  )
}

export function Field({ label, hint, children, className }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cn('flex flex-col gap-1.5', className)}>
      <span className="pl-1 text-sm font-medium text-ink">{label}</span>
      {children}
      {hint && <span className="pl-1 text-xs text-ink-2">{hint}</span>}
    </label>
  )
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn('press relative inline-flex h-6 w-11 shrink-0 items-center rounded-full disabled:opacity-50', checked ? 'bg-navy' : 'bg-line')}
    >
      <span className={cn('inline-block size-5 rounded-full bg-white shadow transition-transform duration-150', checked ? 'translate-x-5.5' : 'translate-x-0.5')} />
    </button>
  )
}

/* ---------- Jauge ---------- */

export function Meter({ value, max, tone = 'navy', label }: { value: number; max: number; tone?: 'navy' | 'orange' | 'danger'; label?: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0
  const color = tone === 'navy' ? 'bg-navy' : tone === 'orange' ? 'bg-orange' : 'bg-red-600'
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-orange-soft" role="meter" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max} aria-label={label}>
      <div className={cn('h-full rounded-full transition-[width] duration-500', color)} style={{ width: `${pct}%` }} />
    </div>
  )
}

/* ---------- Dialogue ---------- */

export function Dialog({ open, onClose, title, description, children, footer, wide }: {
  open: boolean; onClose: () => void; title: string; description?: string; children: ReactNode; footer?: ReactNode; wide?: boolean
}) {
  const titleId = useId()
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6">
      <div className="absolute inset-0 bg-ink/30 backdrop-blur-[2px]" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cn('rise relative flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-[1.75rem] bg-white shadow-2xl sm:rounded-[1.75rem]', wide ? 'sm:max-w-3xl' : 'sm:max-w-lg')}
      >
        <div className="flex items-start justify-between gap-4 px-6 pt-6 pb-3">
          <div>
            <h2 id={titleId} className="text-2xl font-light tracking-tight">{title}</h2>
            {description && <p className="mt-1 text-sm text-ink-2">{description}</p>}
          </div>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Fermer"><X /></Button>
        </div>
        <div className="overflow-y-auto px-6 pb-6 scroll-thin">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line bg-subtle/60 px-6 py-4">{footer}</div>}
      </div>
    </div>
  )
}

/* ---------- Liste déroulante avec recherche ---------- */

export interface ComboOption {
  value: number
  label: string
  hint?: string
  group?: string
}

export function Combobox({ options, value, onChange, placeholder, emptyText = 'Aucun résultat', className, ariaLabel }: {
  options: ComboOption[]
  value: number | null
  onChange: (v: number | null) => void
  placeholder: string
  emptyText?: string
  className?: string
  ariaLabel: string
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const liste = useRef<HTMLUListElement>(null)
  const listId = useId()
  // La liste s'ouvre au premier plan de la page (portail), sous le champ : les cartes givrées
  // (backdrop-filter) forment chacune leur propre plan, qu'une liste ne pourrait pas dépasser
  const [place, setPlace] = useState<{ top: number; left: number; width: number } | null>(null)
  useLayoutEffect(() => {
    if (!open) return
    const placer = () => {
      const r = root.current?.getBoundingClientRect()
      if (r) setPlace({ top: r.bottom + 8, left: r.left, width: r.width })
    }
    placer()
    window.addEventListener('scroll', placer, true)
    window.addEventListener('resize', placer)
    return () => { window.removeEventListener('scroll', placer, true); window.removeEventListener('resize', placer) }
  }, [open])
  const selected = options.find((o) => o.value === value)

  const norm = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
  const filtered = useMemo(() => {
    const n = norm(q.trim())
    return n ? options.filter((o) => norm(`${o.label} ${o.hint ?? ''} ${o.group ?? ''}`).includes(n)) : options
  }, [q, options])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) =>
      !root.current?.contains(e.target as Node) && !liste.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const choose = (o: ComboOption) => {
    onChange(o.value)
    setQ('')
    setOpen(false)
  }

  let lastGroup: string | undefined
  return (
    <div ref={root} className={cn('relative', className)}>
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-ink-2" />
        <input
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          className={cn(fieldBase, 'pr-10 pl-10')}
          placeholder={selected ? selected.label : placeholder}
          value={open ? q : selected?.label ?? ''}
          onFocus={() => { setOpen(true); setActive(0) }}
          onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(0) }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, filtered.length - 1)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
            else if (e.key === 'Enter' && filtered[active]) { e.preventDefault(); choose(filtered[active]) }
            else if (e.key === 'Escape') setOpen(false)
          }}
        />
        {selected ? (
          <button type="button" aria-label="Effacer" onClick={() => { onChange(null); setQ('') }} className="absolute top-1/2 right-3 grid size-6 -translate-y-1/2 place-items-center rounded-full text-ink-2 hover:bg-muted">
            <X className="size-3.5" />
          </button>
        ) : (
          <ChevronDown className="pointer-events-none absolute top-1/2 right-4 size-4 -translate-y-1/2 text-ink-2" />
        )}
      </div>
      {open && place && createPortal(
        <ul ref={liste} id={listId} role="listbox" style={{ top: place.top, left: place.left, width: place.width }}
          className="rise fixed z-[60] max-h-80 overflow-y-auto rounded-3xl border border-white bg-white/95 p-1.5 shadow-xl backdrop-blur scroll-thin">
          {filtered.length === 0 && <li className="px-4 py-3 text-sm text-ink-2">{emptyText}</li>}
          {filtered.map((o, i) => {
            const header = o.group && o.group !== lastGroup ? o.group : null
            lastGroup = o.group
            return (
              <li key={o.value} role="presentation">
                {header && <p className="section-label px-3 pt-2 pb-1">{header}</p>}
                <div
                  role="option"
                  aria-selected={o.value === value}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => { e.preventDefault(); choose(o) }}
                  className={cn('flex cursor-pointer items-center justify-between gap-3 rounded-2xl px-3 py-2 text-sm', i === active ? 'bg-muted' : '')}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{o.label}</span>
                    {o.hint && <span className="block truncate text-xs text-ink-2">{o.hint}</span>}
                  </span>
                  {o.value === value && <Check className="size-4 text-navy" />}
                </div>
              </li>
            )
          })}
        </ul>,
        document.body,
      )}
    </div>
  )
}

/* ---------- Divers ---------- */

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <div className="grid size-14 place-items-center rounded-full bg-white/80 text-navy ring-1 ring-white [&_svg]:size-6">{icon}</div>
      <h3 className="text-xl font-light">{title}</h3>
      {children && <div className="max-w-md text-sm text-ink-2">{children}</div>}
    </div>
  )
}

/** Logo de la plateforme ; `ecole` : code de l'école affiché après le nom (sinon rien) */
export function Logo({ dark, suffix, ecole }: { dark?: boolean; suffix?: string; ecole?: { code: string; nom: string } | null }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5 font-semibold tracking-tight', dark ? 'text-white' : 'text-navy')}>
      <svg viewBox="0 0 32 32" className="size-8" aria-hidden>
        <rect width="32" height="32" rx="9" fill={dark ? '#F7F6F4' : '#03254C'} />
        <rect x="7" y="9" width="18" height="3" rx="1.5" fill={dark ? '#03254C' : '#F7F6F4'} />
        <rect x="7" y="15" width="11" height="3" rx="1.5" fill={dark ? '#03254C' : '#F7F6F4'} />
        <rect x="7" y="21" width="7" height="3" rx="1.5" fill={dark ? '#03254C' : '#F7F6F4'} />
        <circle cx="23" cy="22.5" r="3" fill="#F39B2A" />
      </svg>
      <span className="text-lg leading-none whitespace-nowrap" title={ecole?.nom}>
        Ultraplanning{ecole && <span className="font-light"> {ecole.code}</span>}
        {suffix && <span className={cn('ml-2 rounded-full px-2 py-0.5 text-[11px] font-medium align-middle', dark ? 'bg-white/15 text-white' : 'bg-orange-soft text-[#7C4A03]')}>{suffix}</span>}
      </span>
    </span>
  )
}
