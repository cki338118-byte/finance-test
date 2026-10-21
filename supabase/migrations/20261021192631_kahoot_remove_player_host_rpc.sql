-- Quiz Live: allow the host to remove a participant using the host token.
-- Deleted participants and their answers are excluded from subsequent rankings.
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

  if v_game.status = 'finished' then
    raise exception 'GAME_ALREADY_FINISHED';
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
