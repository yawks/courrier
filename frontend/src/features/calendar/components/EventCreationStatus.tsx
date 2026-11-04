import { useTranslation } from 'react-i18next';
import type { EventCreation } from '../hooks/useEventCreation';

export default function EventCreationStatus({ operations, onRetry, onRecheck, onDismiss }: {
  readonly operations: EventCreation[];
  readonly onRetry: (id: string) => void;
  readonly onRecheck: (id: string) => void;
  readonly onDismiss: (id: string) => void;
}) {
  const { t } = useTranslation();
  if (!operations.length) return null;
  return <div className="calendar-creation-notices">
    {operations.map(op => <div key={op.id} className="calendar-creation-notice">
      <p role={op.state === 'failed' || op.state === 'uncertain' ? 'alert' : 'status'}>
        {t(`createEvent.background.${op.state}`, { title: op.payload.title })}
      </p>
      <div className="calendar-creation-actions">
        {op.state === 'failed' && <button type="button" className="btn-primary" onClick={() => onRetry(op.id)}>{t('createEvent.background.retry')}</button>}
        {(op.state === 'uncertain' || op.state === 'refreshFailed') && <button type="button" className="btn-primary" onClick={() => onRecheck(op.id)}>{t('createEvent.background.check')}</button>}
        {!['saving', 'checking', 'uncertain'].includes(op.state) && <button type="button" className="btn-ghost" onClick={() => onDismiss(op.id)}>{t('eventModal.close')}</button>}
      </div>
    </div>)}
  </div>;
}
