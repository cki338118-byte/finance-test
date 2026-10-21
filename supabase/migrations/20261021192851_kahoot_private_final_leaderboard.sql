-- After a game finishes, the final roster is available only through a host-token RPC.
-- A participant may fetch only their own final score, rank, and participant count.
drop policy if exists "kahoot_players_read_live" on public.kahoot_players;
create policy "kahoot_players_read_live"
on public.kahoot_players
for select
to anon, authenticated
using (
  exists (
    select 1
    from public.kahoot_games g
    where g.id = kahoot_players.game_id
      and g.status <> 'finished'
  )
);

drop policy if exists "kahoot_answers_read_after_reveal" on public.kahoot_answers;
create policy "kahoot_answers_read_after_reveal"
on public.kahoot_answers
for select
to anon, authenticated
using (
  exists (
    select 1
    from public.kahoot_games g
    where g.id = kahoot_answers.game_id
      and g.status in ('reveal', 'leaderboard')
  )
);

create or replace function public.kahoot_get_final_top5(
  p_pin text,
  p_host_token text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_game public.kahoot_games%rowtype;
  v_pepper text;
  v_pin_hash text;
  v_host_hash text;
begin
  select pin_pepper into v_pepper
  from public.kahoot_system_secret
  where id = 1;

  if v_pepper is null then
    raise exception 'KAHOOT_SECRET_NOT_INITIALIZED';
  end if;

  v_pin_hash := encode(digest(trim(coalesce(p_pin, '')) || v_pepper, 'sha256'), 'hex');
  select * into v_game
  from public.kahoot_games
  where pin_hash = v_pin_hash
  limit 1;

  if not found then
    raise exception 'GAME_NOT_FOUND';
  end if;

  if v_game.status <> 'finished' then
    raise exception 'FINAL_RESULTS_NOT_READY';
  end if;

  select token_hash into v_host_hash
  from public.kahoot_host_secrets
  where game_id = v_game.id;

  if v_host_hash is null
    or v_host_hash <> encode(digest(coalesce(p_host_token, ''), 'sha256'), 'hex') then
    raise exception 'INVALID_HOST_TOKEN';
  end if;

  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'id', ranked.id,
        'game_id', ranked.game_id,
        'player_name', ranked.player_name,
        'score', ranked.score,
        'streak', ranked.streak,
        'answered', ranked.answered,
        'joined_at', ranked.joined_at
      )
      order by ranked.score desc, ranked.joined_at asc, ranked.id::text asc
    )
    from (
      select p.id, p.game_id, p.player_name, p.score, p.streak, p.answered, p.joined_at
      from public.kahoot_players p
      where p.game_id = v_game.id
      order by p.score desc, p.joined_at asc, p.id::text asc
      limit 5
    ) ranked
  ), '[]'::jsonb);
end;
$function$;

revoke all on function public.kahoot_get_final_top5(text, text) from public;
grant execute on function public.kahoot_get_final_top5(text, text) to anon, authenticated, service_role;

create or replace function public.kahoot_get_player_final_result(
  p_pin text,
  p_player_id uuid,
  p_player_token text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_game public.kahoot_games%rowtype;
  v_player public.kahoot_players%rowtype;
  v_pepper text;
  v_pin_hash text;
  v_player_hash text;
  v_place integer;
  v_participant_count integer;
begin
  select pin_pepper into v_pepper
  from public.kahoot_system_secret
  where id = 1;

  if v_pepper is null then
    raise exception 'KAHOOT_SECRET_NOT_INITIALIZED';
  end if;

  v_pin_hash := encode(digest(trim(coalesce(p_pin, '')) || v_pepper, 'sha256'), 'hex');
  select * into v_game
  from public.kahoot_games
  where pin_hash = v_pin_hash
  limit 1;

  if not found then
    raise exception 'GAME_NOT_FOUND';
  end if;

  if v_game.status <> 'finished' then
    raise exception 'FINAL_RESULTS_NOT_READY';
  end if;

  select * into v_player
  from public.kahoot_players
  where id = p_player_id and game_id = v_game.id;

  if not found then
    raise exception 'PLAYER_NOT_FOUND';
  end if;

  select token_hash into v_player_hash
  from public.kahoot_player_secrets
  where player_id = v_player.id;

  if v_player_hash is null
    or v_player_hash <> encode(digest(coalesce(p_player_token, ''), 'sha256'), 'hex') then
    raise exception 'INVALID_PLAYER_TOKEN';
  end if;

  select count(*) into v_participant_count
  from public.kahoot_players
  where game_id = v_game.id;

  select count(*) + 1 into v_place
  from public.kahoot_players p
  where p.game_id = v_game.id
    and (
      p.score > v_player.score
      or (
        p.score = v_player.score
        and (
          p.joined_at < v_player.joined_at
          or (p.joined_at = v_player.joined_at and p.id::text < v_player.id::text)
        )
      )
    );

  return jsonb_build_object(
    'score', v_player.score,
    'place', v_place,
    'participant_count', v_participant_count
  );
end;
$function$;

revoke all on function public.kahoot_get_player_final_result(text, uuid, text) from public;
grant execute on function public.kahoot_get_player_final_result(text, uuid, text) to anon, authenticated, service_role;

-- Removal is only allowed before the game starts, where the host UI exposes this control.
create or replace function public.kahoot_remove_player(
  p_pin text,
  p_host_token text,
  p_player_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_game public.kahoot_games%rowtype;
  v_pepper text;
  v_pin_hash text;
  v_host_hash text;
begin
  select pin_pepper into v_pepper
  from public.kahoot_system_secret
  where id = 1;

  if v_pepper is null then
    raise exception 'KAHOOT_SECRET_NOT_INITIALIZED';
  end if;

  v_pin_hash := encode(digest(trim(coalesce(p_pin, '')) || v_pepper, 'sha256'), 'hex');

  select * into v_game
  from public.kahoot_games
  where pin_hash = v_pin_hash
  for update;

  if not found then
    raise exception 'GAME_NOT_FOUND';
  end if;

  select token_hash into v_host_hash
  from public.kahoot_host_secrets
  where game_id = v_game.id;

  if v_host_hash is null
    or v_host_hash <> encode(digest(coalesce(p_host_token, ''), 'sha256'), 'hex') then
    raise exception 'INVALID_HOST_TOKEN';
  end if;

  if v_game.status <> 'lobby' then
    raise exception 'REMOVAL_ONLY_IN_LOBBY';
  end if;

  if not exists (
    select 1 from public.kahoot_players
    where id = p_player_id and game_id = v_game.id
  ) then
    raise exception 'PLAYER_NOT_FOUND';
  end if;

  delete from public.kahoot_answers
  where game_id = v_game.id and player_id = p_player_id;

  delete from public.kahoot_player_secrets
  where player_id = p_player_id;

  delete from public.kahoot_players
  where id = p_player_id and game_id = v_game.id;

  return jsonb_build_object('ok', true, 'player_id', p_player_id);
end;
$function$;

revoke all on function public.kahoot_remove_player(text, text, uuid) from public;
grant execute on function public.kahoot_remove_player(text, text, uuid) to anon, authenticated, service_role;
