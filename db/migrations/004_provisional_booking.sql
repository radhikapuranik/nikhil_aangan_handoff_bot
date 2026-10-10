-- A booking made automatically after the call, before the caller has been told the time.
alter table calls drop constraint if exists calls_booking_status_check;
alter table calls add constraint calls_booking_status_check
  check (booking_status in ('not_applicable','offered','booked','provisional','declined_by_caller','failed'));
