import { useState, type FormEvent } from 'react';
import { remplir } from '../../auth/droits';
import { PageHeader } from '../../components/ui';
import { formatDate } from '../../lib/helpers';
import { libelleSemestre, parametres } from '../../lib/planning';
import { useData } from '../../store/DataContext';
import { CODES_CS, CS_LABELS, type GabaritEmail, type Parametres } from '../../types';

// Page 28 — Paramètres : semestre actif, heures maximales par jour pour un
// enseignant (CS-06), poids par défaut des contraintes souples (BF-16) et
// gabarits des e-mails envoyés par l'application (BF-10, BF-20).

const EXEMPLE = {
  nom: 'Aminata Ouédraogo',
  semestre: 'S1 2027-2028',
  version: 4,
  changements: 2,
  date_limite: formatDate('2027-06-30'),
  seance: 'IA501 CM · M2-IA · Lundi 08:00 · A-AMPHI2',
};

export default function ParametresPage() {
  const { db, save } = useData();
  const [draft, setDraft] = useState<Parametres>(parametres(db));
  const [enregistre, setEnregistre] = useState(false);
  const [gabaritId, setGabaritId] = useState(db.gabarits[0]?.id);
  const gabarit = db.gabarits.find((g) => g.id === gabaritId);
  const semestres = db.semestres.filter((s) => s.statut !== 'cloturee');

  function envoyer(e: FormEvent) {
    e.preventDefault();
    save('parametres', draft);
    setEnregistre(true);
  }

  const modifier = (p: Partial<Parametres>) => {
    setEnregistre(false);
    setDraft((d) => ({ ...d, ...p }));
  };

  return (
    <>
      <PageHeader title="Paramètres" refs="CS-06, BF-16, BF-20" />

      <form className="card form" onSubmit={envoyer}>
        <h2>Planification</h2>
        <div className="grid-2 form-grid">
          <div className="field">
            <label htmlFor="par-semestre">Semestre actif</label>
            <select id="par-semestre" className="input" value={draft.semestreActifId} onChange={(e) => modifier({ semestreActifId: Number(e.target.value) })}>
              {semestres.map((s) => (
                <option key={s.id} value={s.id}>
                  {libelleSemestre(db, s)}
                </option>
              ))}
            </select>
            <span className="muted small">Semestre de la grille, de la génération et de la consultation.</span>
          </div>
          <div className="field">
            <label htmlFor="par-max">Heures maximales par jour pour un enseignant (CS-06)</label>
            <input
              id="par-max"
              type="number"
              className="input input-num"
              min={2}
              max={12}
              step={1}
              value={draft.heuresMaxJour}
              onChange={(e) => modifier({ heuresMaxJour: Math.max(2, Math.min(12, Number(e.target.value) || 2)) })}
            />
          </div>
        </div>

        <h3>Poids par défaut des contraintes souples</h3>
        <p className="muted small">Proposés à chaque génération ; le planificateur peut les ajuster avant de lancer le calcul (0 = ignorée, 10 = prioritaire).</p>
        {CODES_CS.map((code) => (
          <div className="field slider-field" key={code}>
            <label htmlFor={`par-${code}`}>
              <span className="badge">{code}</span> {CS_LABELS[code]}
            </label>
            <div className="slider-row">
              <input
                id={`par-${code}`}
                type="range"
                min={0}
                max={10}
                value={draft.poidsDefaut[code]}
                onChange={(e) => modifier({ poidsDefaut: { ...draft.poidsDefaut, [code]: Number(e.target.value) } })}
              />
              <output htmlFor={`par-${code}`} className="slider-value">
                {draft.poidsDefaut[code]}
              </output>
            </div>
          </div>
        ))}
        <div className="form-actions">
          {enregistre && (
            <span className="text-success" role="status">
              Paramètres enregistrés.
            </span>
          )}
          <button type="submit" className="btn btn-primary">
            Enregistrer
          </button>
        </div>
      </form>

      <section className="card">
        <div className="section-head">
          <h2>Gabarits d’e-mail</h2>
          <select className="input" aria-label="Gabarit" value={gabaritId} onChange={(e) => setGabaritId(Number(e.target.value))}>
            {db.gabarits.map((g) => (
              <option key={g.id} value={g.id}>
                {g.libelle}
              </option>
            ))}
          </select>
        </div>
        {gabarit && <EditeurGabarit key={gabarit.id} gabarit={gabarit} onSave={(g) => save('gabarits', g)} />}
      </section>
    </>
  );
}

function EditeurGabarit({ gabarit, onSave }: { gabarit: GabaritEmail; onSave: (g: GabaritEmail) => void }) {
  const [sujet, setSujet] = useState(gabarit.sujet);
  const [corps, setCorps] = useState(gabarit.corps);
  const [enregistre, setEnregistre] = useState(false);
  const variables = [...new Set([...`${gabarit.sujet} ${gabarit.corps}`.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))];
  const inconnues = [...`${sujet} ${corps}`.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((v) => !(v in EXEMPLE));

  return (
    <div className="grid-2 gabarit">
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (inconnues.length) return;
          onSave({ ...gabarit, sujet, corps });
          setEnregistre(true);
        }}
      >
        <div className="field">
          <label htmlFor="gab-sujet">Objet</label>
          <input id="gab-sujet" className="input" value={sujet} onChange={(e) => (setSujet(e.target.value), setEnregistre(false))} />
        </div>
        <div className="field">
          <label htmlFor="gab-corps">Message</label>
          <textarea id="gab-corps" className="input" rows={9} value={corps} onChange={(e) => (setCorps(e.target.value), setEnregistre(false))} />
        </div>
        <p className="muted small">
          Variables :{' '}
          {variables.map((v) => (
            <code key={v} className="var-code">{`{${v}}`}</code>
          ))}
        </p>
        {inconnues.length > 0 && (
          <p className="error" role="alert">
            Variable inconnue : {inconnues.map((v) => `{${v}}`).join(', ')}
          </p>
        )}
        <div className="form-actions">
          {enregistre && (
            <span className="text-success" role="status">
              Gabarit enregistré.
            </span>
          )}
          <button type="submit" className="btn btn-primary" disabled={inconnues.length > 0}>
            Enregistrer le gabarit
          </button>
        </div>
      </form>
      <div className="email-preview">
        <p className="muted small">Aperçu avec des valeurs d’exemple</p>
        <p>
          <strong>{remplir(sujet, EXEMPLE)}</strong>
        </p>
        <pre>{remplir(corps, EXEMPLE)}</pre>
      </div>
    </div>
  );
}
