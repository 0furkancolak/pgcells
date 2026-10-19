--
-- PostgreSQL database dump (eski uygulama; e2e fixture'ı, gerçek veri değildir)
--

SET statement_timeout = 0;
SET lock_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;

CREATE TABLE public.uyeler (
    id integer NOT NULL,
    email character varying(255),
    ad_soyad text,
    sifre text
);

ALTER TABLE public.uyeler OWNER TO eski;

CREATE TABLE public.dersler (
    id integer NOT NULL,
    baslik text NOT NULL
);

CREATE TABLE public.ogrenciler (
    id integer NOT NULL,
    ad text NOT NULL
);

CREATE TABLE public.kayitlar (
    ogrenci_id integer NOT NULL,
    ders_id integer NOT NULL
);

COPY public.uyeler (id, email, ad_soyad, sifre) FROM stdin;
1	veli@eski.example	Veli Yılmaz	$2b$04$fz/eatsIv1PmMUrIehRioeR0/9tDZLuHI8nzepZGk7GinubQr48ce
2	\N	E-postasız Üye	\N
\.

COPY public.dersler (id, baslik) FROM stdin;
1	Kimya
2	Biyoloji
\.

COPY public.ogrenciler (id, ad) FROM stdin;
1	Ayşe Demir
2	Mehmet Kaya
3	Zeynep O'Brien
\.

COPY public.kayitlar (ogrenci_id, ders_id) FROM stdin;
1	1
1	2
2	1
3	2
\.

ALTER TABLE ONLY public.uyeler
    ADD CONSTRAINT uyeler_pkey PRIMARY KEY (id);

CREATE INDEX kayitlar_ders_idx ON public.kayitlar USING btree (ders_id);

--
-- PostgreSQL database dump complete
--
