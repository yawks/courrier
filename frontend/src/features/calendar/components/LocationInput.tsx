import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CalendarConfig } from '../../../shared/types';
import { discoverCalendarRooms, searchCalendarRoomDirectory, type CalendarRoom, type RoomDiscoveryAuth } from '../utils/roomDiscovery';
import { queryRoomAvailability, type RoomAvailability, type RoomAvailabilityAuth } from '../utils/roomAvailability';

interface Props extends RoomDiscoveryAuth, RoomAvailabilityAuth {
  calendar?: CalendarConfig;
  value: string;
  onChange: (value: string) => void;
  start?: string;
  end?: string;
}

/** A free-text combobox: room suggestions fill the location, not a booking. */
export default function LocationInput({ calendar, value, onChange, getValidToken, getExchangeToken, getExchangeRefreshToken, start, end }: Props) {
  const { t } = useTranslation();
  const listId = useId();
  const helpId = useId();
  const [activated, setActivated] = useState(false);
  const [rooms, setRooms] = useState<CalendarRoom[]>([]);
  const [loading, setLoading] = useState(false);
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [directoryResult, setDirectoryResult] = useState<{ query: string; rooms: CalendarRoom[] }>({ query: '', rooms: [] });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const activeRef = useRef<HTMLLIElement>(null);
  const query = value.trim();
  const known = rooms.filter(room => `${room.name} ${room.email ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const knownIds = new Set(known.map(room => (room.email || room.id).toLowerCase()));
  const directory = directoryResult.query === query ? directoryResult.rooms : [];
  const matches = [...known, ...directory.filter(room => !knownIds.has((room.email || room.id).toLowerCase()))].slice(0, 20);
  const expanded = open && matches.length > 0;
  const emailsKey = JSON.stringify(matches.flatMap(room => room.email ? [room.email.toLowerCase()] : []).sort());
  const availabilityKey = JSON.stringify([calendar?.id, start, end, emailsKey]);
  const [availability, setAvailability] = useState<{ key: string; values: Record<string, RoomAvailability> }>({ key: '', values: {} });
  const [checkingKey, setCheckingKey] = useState('');

  useEffect(() => {
    if (!expanded || !calendar || !start || !end || !['exchange', 'google'].includes(calendar.type ?? '')) return;
    let cancelled = false;
    setCheckingKey(availabilityKey);
    const timer = setTimeout(() => {
      void queryRoomAvailability(calendar, JSON.parse(emailsKey), new Date(start), new Date(end), { getValidToken, getExchangeRefreshToken })
        .then(values => { if (!cancelled) { setAvailability({ key: availabilityKey, values }); setCheckingKey(''); } });
    }, 350);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [expanded, calendar, start, end, emailsKey, availabilityKey, getValidToken, getExchangeRefreshToken]);

  useEffect(() => {
    console.info('[Room discovery] location autocomplete ready', { provider: calendar?.type ?? 'unknown', trigger: 'focus or typing' });
  }, [calendar?.type]);

  useEffect(() => {
    if (!activated || !calendar) return;
    let cancelled = false;
    setLoading(true);
    void discoverCalendarRooms(calendar, { getValidToken, getExchangeToken }).then(found => {
      if (!cancelled) { setRooms(found); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, [activated, calendar, getValidToken, getExchangeToken]);

  useEffect(() => {
    if (!activated || !open || calendar?.type !== 'exchange' || query.length < 2) {
      setDirectoryLoading(false);
      return;
    }
    let cancelled = false;
    setDirectoryLoading(true);
    const timer = setTimeout(() => {
      void searchCalendarRoomDirectory(calendar, query, { getExchangeToken }).then(found => {
        if (!cancelled) { setDirectoryResult({ query, rooms: found }); setDirectoryLoading(false); setActive(-1); }
      });
    }, 350);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [activated, open, calendar, query, getExchangeToken]);

  useEffect(() => { activeRef.current?.scrollIntoView?.({ block: 'nearest' }); }, [active]);

  const select = (room: CalendarRoom) => {
    onChange(room.name);
    setOpen(false);
    setActive(-1);
  };

  return <div className="location-input">
    <input
      id="ev-location"
      type="text"
      role="combobox"
      aria-autocomplete="list"
      aria-busy={loading || directoryLoading}
      aria-expanded={expanded}
      aria-controls={expanded ? listId : undefined}
      aria-activedescendant={expanded && active >= 0 && matches[active] ? `${listId}-${active}` : undefined}
      aria-describedby={matches.length ? helpId : undefined}
      autoComplete="off"
      spellCheck={false}
      autoCorrect="off"
      autoCapitalize="none"
      value={value}
      placeholder={t('createEvent.locationPlaceholder')}
      onFocus={() => { setActivated(true); setOpen(true); }}
      onBlur={() => { setOpen(false); setActive(-1); }}
      onChange={event => { setActivated(true); onChange(event.target.value); setOpen(true); setActive(-1); }}
      onKeyDown={event => {
        if (event.key === 'Escape' && open) {
          event.preventDefault(); event.stopPropagation(); setOpen(false); setActive(-1);
        } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && matches.length) {
          event.preventDefault(); setOpen(true);
          setActive(index => event.key === 'ArrowDown' ? Math.min(index + 1, matches.length - 1) : index <= 0 ? matches.length - 1 : index - 1);
        } else if (event.key === 'Enter' && expanded && active >= 0 && matches[active]) {
          event.preventDefault(); select(matches[active]);
        }
      }}
    />
    {expanded && <ul id={listId} role="listbox" aria-label={t('createEvent.roomSuggestions')} className="location-input__suggestions">
      {matches.map((room, index) => {
        const status = checkingKey === availabilityKey ? 'checking'
          : availability.key === availabilityKey && room.email ? availability.values[room.email.toLowerCase()] ?? 'unknown' : 'unknown';
        return <li
        id={`${listId}-${index}`}
        key={room.id}
        role="option"
        aria-selected={index === active}
        ref={index === active ? activeRef : undefined}
        className={`location-input__option${index === active ? ' location-input__option--active' : ''}`}
        onMouseDown={event => event.preventDefault()}
        onClick={() => select(room)}
      >
        <span className="location-input__name">{room.name}</span>
        <span className={`location-input__availability location-input__availability--${status}`} role="status">
          <span className="location-input__status-dot" aria-hidden="true" />
          {t(`createEvent.roomAvailability.${status}`)}
        </span>
      </li>;
      })}
    </ul>}
    {(rooms.length > 0 || matches.length > 0) && <p id={helpId} className="location-input__help">{t('createEvent.roomLocationOnly')}</p>}
  </div>;
}
