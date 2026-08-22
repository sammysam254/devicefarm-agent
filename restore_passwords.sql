-- ══════════════════════════════════════════════════════════════════════════════
-- RESTORE ORIGINAL PASSWORD HASHES & ATTACH PROFILE CREATION TRIGGER
-- Run this in your NEW Supabase SQL Editor
-- ══════════════════════════════════════════════════════════════════════════════

-- 1. Restore all original bcrypt password hashes
UPDATE auth.users u
SET encrypted_password = v.pwd
FROM (VALUES
  ('76eeb120-1ea5-44a5-b924-0f5968ad5ae6'::uuid, '$2a$10$R8Ja2HH2xNgIP0JKf03AvurGuS2w/ynGyCwnrKXxiP.gucV57p2y.'),
  ('707001e5-25b8-4d6f-b9a3-9fc501ec52e5'::uuid, '$2a$10$p3VdWihwMbhiYED5ZY3.LeCzpW74B.4D9ErbhinvmkeWEwfUmmduK'),
  ('0b3879b9-c823-434c-9c8f-12d2ff7f8f91'::uuid, '$2a$10$2ZEKHoLk.flBruszKSITAelQjYy5AiIhh03V2KMEWtpsRrkOb6Z3q'),
  ('a3b92bff-63f3-4d2f-8d20-556438e210d3'::uuid, '$2a$10$affISRIzu44HiU3kyj66y.TntHLOtu3kjIMR8hxKb5FmFFJd4I6ku'),
  ('308236a0-a5e6-4c70-80f0-c5b60aba57ec'::uuid, '$2a$10$8UebwrOlyBELn55JfIORMu5VrRh5fHjEHmDsLXwokxn7/juyBW3vS'),
  ('8578324b-1e59-4fec-8423-20546173cb86'::uuid, '$2a$10$XvtephRUhpdFh9TyXHcgEuJ8SzdRf/o7kEur/wWjo11fDdx1QL5la'),
  ('95daa7dc-c17a-4caf-bf39-1fc03ed117be'::uuid, '$2a$10$ldN0E3.MJAIOp3nHe5T0qOxqybOBpQAmAfG8p5X0MMKlWVf24YRCi'),
  ('019443f6-50cf-4560-824f-27cd93a4e30b'::uuid, '$2a$10$wZpLNr./HULbCHYpQq1SYeHiwu97z4K1Xe0y7X/5/w9Gz9RYoVNZ2'),
  ('9818bf20-c42d-4b84-9885-64277ba5eb62'::uuid, '$2a$10$rHhCG5ybD5CuYn/vgJR4veT5A5p3s5RxuD1Sr9otv.gTOHoAp1x1K'),
  ('9c0ff971-83df-4540-af4b-92e9ed79240d'::uuid, '$2a$10$l6h0.JWj8n.b.z6Z8e8KL.F1mAqXlBd/EVP3K4H179Co2qN5U9DPW'),
  ('dfddbc44-d861-4d34-8fed-5ac5071ebcd9'::uuid, '$2a$10$VKxcMBiPyIpJ4rzopR0ehurR1iDHRD23X8FSGJIvWCwaO51AZunM6'),
  ('337707f5-9573-47da-a613-1eb80a6f62f0'::uuid, '$2a$10$rUzT6Z8pnzCw6dLivCCPmuv8IyxCNYR/4pt9qIjNdMbkvqJzBK2Ka'),
  ('853b0d9c-6b74-4699-b606-05abd8ac3df9'::uuid, '$2a$10$dUXEjKYAOdGsAhn.myqMUOd3Q6bQx.MNbiBQiqnDIAggwOuk5/Wk.'),
  ('b0c2be32-df91-47a4-8898-90ab2f6df85b'::uuid, '$2a$10$dmCUfzc.ZvuZ61/PHpGd5.xmecpKQW/7ThQEP8caMxJgZfnzcpxo.'),
  ('42033b6d-38ef-4354-9253-968abcefe026'::uuid, '$2a$10$ccwXmxgh5AEuvtHTTbNWTuol9MovWByqS5G2Yy72PuUn0v9GElbRm'),
  ('cdfa9620-b1fa-4693-908f-fa17409f467c'::uuid, '$2a$10$C6nPCPUz6.sjpjjWGjqiIeX6.IqGlUl7qNRjxC72jTTaJFnmQX6MK'),
  ('59427519-8043-4425-9e0b-019db51b1b2c'::uuid, '$2a$10$LSIh3EmNSqoJ0W2D.YBjaOsKvGEc7NPaENT8FDv0eEzpbRgvOHfX6'),
  ('c7ba5c95-79ad-403f-a6e2-8bb1f6066b76'::uuid, '$2a$10$y4yd0hY00noM82gGGyRRhus2iQocuvHH3PKSQG.sn2AFl6A89tXvu'),
  ('1c19d8b0-6127-4230-a07c-67786ad4ca76'::uuid, '$2a$10$RDn2OQnD0vW9MHABQCc3v.5j8egMgiT/Sk5arMV6IpDR5CAdnpCmm'),
  ('578da9f3-9fed-4f48-9f1a-8ea586ad62b5'::uuid, '$2a$10$OsXp11LW80I1uxfckxjG.eoUT4ZGK/qpRwk6XwFrT8XRNUehXS61a'),
  ('8b2d784f-a221-49b4-a4c5-30ca3608e104'::uuid, '$2a$10$Vs.wxftTQGrWPGWdCJB77OoWf7P1/rFAgslZN3gxIkzR32/u6bfdm'),
  ('7c65fb78-552c-4479-b290-dbd08bb0fb81'::uuid, '$2a$10$YuGswnEaFfPkiO787XoQXej2bq7f5EoZy5cRRBPqUwaE5VtLuMmoi'),
  ('69b9955c-0df6-46af-9b4b-8a909afcf4dc'::uuid, '$2a$10$ghXACGbCX0zO5Aahh5wCqOt0xyZdPNFjloOYpb6vfh9EUsQbt4PWK'),
  ('33fa0532-4007-4e94-a7ca-4ebfad585bf5'::uuid, '$2a$10$8OSY.wmRN/IMs6wLCafo/O8PMNyujkOUk9IleqZNlKwp7op7urFdq'),
  ('43ff12a8-2d31-409b-9fff-3edb2f7a7af9'::uuid, '$2a$10$7gFMv9dTqlOIrhCNMeGGxuhMs3gskvR4ggBFI0fCzHpviSRKcalQ6')
) AS v(uid, pwd)
WHERE u.id = v.uid;

-- 2. Re-enable new user profile trigger for future signups
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
