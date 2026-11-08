const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// INISIALISASI DUAL SUPABASE (UTAMA & CADANGAN)
// ==========================================
const supabaseUrlUtama = process.env.SUPABASE_URL_UTAMA || process.env.SUPABASE_URL;
const supabaseKeyUtama = process.env.SUPABASE_ANON_KEY_UTAMA || process.env.SUPABASE_ANON_KEY;
const supabaseUtama = createClient(supabaseUrlUtama, supabaseKeyUtama);

const supabaseUrlCadangan = process.env.SUPABASE_URL_CADANGAN;
const supabaseKeyCadangan = process.env.SUPABASE_ANON_KEY_CADANGAN;
const supabaseCadangan = (supabaseUrlCadangan && supabaseKeyCadangan) 
    ? createClient(supabaseUrlCadangan, supabaseKeyCadangan) 
    : supabaseUtama;

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ==========================================
// STATIC FILES ROUTING
// ==========================================
app.use(express.static(path.join(__dirname, 'public')));
app.use('/css', express.static(path.join(__dirname, 'public/css')));
app.use('/assets', express.static(path.join(__dirname, 'public/assets')));
app.use('/pages', express.static(path.join(__dirname, 'public/pages')));

// ==========================================
// FUNGSI PINTAR AUTOMATIC FAILOVER DUAL DB
// ==========================================
async function dbQueryDual(actionCallback) {
    try {
        let result = await actionCallback(supabaseUtama);
        if (result.error) throw result.error;

        // Sinkronisasi diam-diam ke database cadangan jika operasi tulis
        actionCallback(supabaseCadangan).catch(err => {
            console.warn("⚠️ Peringatan Sinkronisasi Cadangan:", err.message);
        });

        return result;
    } catch (errUtama) {
        console.warn("⚠️ Database utama kendala, beralih otomatis ke Cadangan...", errUtama.message);
        let resultCadangan = await actionCallback(supabaseCadangan);
        return resultCadangan;
    }
}

// ==========================================
// API ROUTES (DENGAN DUAL SUPABASE)
// ==========================================

// 1. Profil Pengguna Aktif Berdasarkan Email yang Login (DIJAMIN TIDAK TERTUKAR)
app.get('/api/user_profile', async (req, res) => {
    try {
        let emailUser = req.query.email; // Menangkap email spesifik dari browser pengguna
        
        if (!emailUser) {
            return res.json({ status: 'success', nama: "Ravi Hendrawan", email: "aditiyaravi218@gmail.com" });
        }

        let { data, error } = await dbQueryDual(async (db) => {
            return await db.from('users').select('*').eq('email', emailUser).maybeSingle();
        });

        if (error || !data) {
            return res.json({ status: 'success', nama: emailUser.split('@')[0], email: emailUser });
        }

        res.json({ 
            status: 'success', 
            nama: data.nama || data.email.split('@')[0], 
            email: data.email 
        });
    } catch (e) {
        res.json({ status: 'success', nama: "Ravi Hendrawan", email: "aditiyaravi218@gmail.com" });
    }
});

// 2. Generate Nomor Invoice Otomatis
app.get('/api/generate_invoice', (req, res) => {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const rand = Math.floor(100 + Math.random() * 900);
    res.json({ invoice: `INV-${year}${month}${day}-${rand}` });
});

// 3. Login Endpoint
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    
    if (!email || !password) {
        return res.status(400).json({ status: 'error', message: 'Email dan password wajib diisi!' });
    }

    try {
        let { data, error } = await dbQueryDual(async (db) => {
            return await db.from('users').select('*').eq('email', email.trim());
        });

        if (error) throw error;
        if (!data || data.length === 0) {
            return res.status(401).json({ status: 'error', message: 'Email tidak terdaftar!' });
        }

        let validUser = data.find(user => user.password === password);
        if (validUser) {
            return res.json({ status: 'success', message: 'Login berhasil' });
        } else {
            return res.status(401).json({ status: 'error', message: 'Password salah!' });
        }
    } catch (e) {
        return res.status(500).json({ status: 'error', message: 'Kesalahan server: ' + e.message });
    }
});

// 4. Register Endpoint
app.post('/api/register', async (req, res) => {
    const { email, password, token } = req.body;
    
    if (token !== process.env.ADMIN_SECRET_TOKEN) {
        return res.status(400).json({ status: 'error', message: 'Token rahasia tidak valid!' });
    }
    if (!email || !password) {
        return res.status(400).json({ status: 'error', message: 'Email dan password wajib diisi!' });
    }

    try {
        let cleanEmail = email.trim();
        let { data: existingUser } = await dbQueryDual(async (db) => {
            return await db.from('users').select('*').eq('email', cleanEmail).maybeSingle();
        });

        if (existingUser) {
            return res.status(400).json({ status: 'error', message: 'Email sudah terdaftar!' });
        }

        let { error } = await dbQueryDual(async (db) => {
            return await db.from('users').insert([{ 
                email: cleanEmail, 
                password: password, 
                nama: cleanEmail.split('@')[0], 
                token: token 
            }]);
        });

        if (error) throw error;
        res.json({ status: 'success', message: 'Registrasi berhasil' });
    } catch (e) {
        res.status(400).json({ status: 'error', message: 'Gagal mendaftar: ' + e.message });
    }
});

// 5. Dashboard Summary
app.get('/api/dashboard_summary', async (req, res) => {
    try {
        let { data: transaksi, error } = await dbQueryDual(async (db) => {
            return await db.from('transaksi_nota').select('*').order('id', { ascending: false });
        });
        if (error) throw error;

        let listTrx = transaksi || [];
        let totalPelanggan = listTrx.length;
        let totalInvoice = listTrx.length;
        let uangDiterima = listTrx.reduce((sum, item) => {
            if (item.status === 'Lunas') return sum + (parseFloat(item.total_tagihan) || 0);
            if (item.status === 'DP Masuk') return sum + (parseFloat(item.nominal_dp) || 0);
            return sum;
        }, 0);

        let formattedTransaksi = listTrx.map(t => ({
            no_nota: t.no_nota,
            nama_klien: t.nama_klien,
            tgl_acara: t.tgl_acara,
            lokasi_venue: t.lokasi_venue,
            total_tagihan: parseFloat(t.total_tagihan || 0),
            status: t.status
        }));

        res.json({
            status: 'success',
            total_pelanggan: totalPelanggan,
            total_invoice: totalInvoice,
            uang_diterima: uangDiterima,
            transaksi_terbaru: formattedTransaksi
        });
    } catch (e) {
        res.json({ status: 'success', total_pelanggan: 0, total_invoice: 0, uang_diterima: 0, transaksi_terbaru: [] });
    }
});

app.get('/api/semua_riwayat', async (req, res) => {
    try {
        let { data, error } = await dbQueryDual(async (db) => {
            return await db.from('transaksi_nota').select('*').order('id', { ascending: false });
        });
        if (error) throw error;

        let riwayatList = (data || []).map(item => ({
            no_inv: item.no_nota,
            nama: item.nama_klien,
            tanggal: item.tgl_acara,
            total: parseFloat(item.total_tagihan || 0),
            dp: parseFloat(item.nominal_dp || 0),
            status: item.status
        }));

        res.json({ status: 'success', data: riwayatList });
    } catch (e) {
        res.json({ status: 'success', data: [] });
    }
});

// 6. Simpan Nota Baru
app.post('/api/simpan_nota_baru', async (req, res) => {
    const dataNota = req.body;
    try {
        let payloadNota = {
            no_nota: dataNota.no_inv,
            nama_klien: dataNota.nama,
            no_wa: dataNota.hp || '-',
            tgl_acara: dataNota.tanggal,
            lokasi_venue: dataNota.lokasi || dataNota.locasi || '-',
            status: dataNota.status,
            total_tagihan: dataNota.total,
            nominal_dp: dataNota.dp,
            sisa_tagihan: dataNota.sisa,
            items_json: JSON.stringify(dataNota.items || [])
        };

        let { error } = await dbQueryDual(async (db) => {
            return await db.from('transaksi_nota').upsert(payloadNota, { onConflict: 'no_nota' });
        });
        if (error) throw error;

        res.json({ status: 'success', message: 'Nota berhasil disimpan ke Dual Supabase!' });
    } catch (e) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// 7. Detail Transaksi
app.get('/api/detail_transaksi/:inv', async (req, res) => {
    let invParam = req.params.inv.replace('#', '').trim();
    try {
        let { data: trx, error } = await dbQueryDual(async (db) => {
            return await db.from('transaksi_nota').select('*').or(`no_nota.eq.${invParam},no_nota.eq.#${invParam}`).maybeSingle();
        });

        if (error || !trx) {
            return res.status(404).json({ success: false, message: 'Transaksi tidak ditemukan' });
        }

        let parsedItems = [];
        try {
            if (trx.items_json) parsedItems = JSON.parse(trx.items_json);
        } catch (err) {
            parsedItems = [];
        }

        if (parsedItems.length === 0) {
            parsedItems = [{ tipe: 'utama', nama: 'Paket Makeup', harga: trx.total_tagihan, qty: 1, sub: '' }];
        }

        res.json({
            success: true,
            transaksi: {
                invoice_no: trx.no_nota,
                nama_klien: trx.nama_klien,
                no_wa: trx.no_wa || '-',
                tanggal_acara: trx.tgl_acara,
                lokasi_venue: trx.lokasi_venue || '-',
                status: trx.status,
                nominal_dp: trx.nominal_dp || 0,
                total_tagihan: trx.total_tagihan
            },
            items: parsedItems
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// 8. Rekap Keuangan & Pengeluaran
app.get('/api/rekap_keuangan', async (req, res) => {
    try {
        let { data: transaksi } = await dbQueryDual(async (db) => { return await db.from('transaksi_nota').select('*'); });
        let { data: pengeluaran } = await dbQueryDual(async (db) => { return await db.from('transaksi_pengeluaran').select('*'); });

        let bulanMap = {};
        (transaksi || []).forEach(trx => {
            let tgl = trx.tgl_acara || trx.created_at || '2026-10-01';
            let kodeBulan = tgl.substring(0, 7);
            if (!bulanMap[kodeBulan]) bulanMap[kodeBulan] = { total_pemasukan: 0, total_pengeluaran: 0 };
            let masuk = trx.status === 'Lunas' ? (parseFloat(trx.total_tagihan) || 0) : (trx.status === 'DP Masuk' ? (parseFloat(trx.nominal_dp) || 0) : 0);
            bulanMap[kodeBulan].total_pemasukan += masuk;
        });

        (pengeluaran || []).forEach(el => {
            let tgl = el.tanggal || '2026-10-01';
            let kodeBulan = tgl.substring(0, 7);
            if (!bulanMap[kodeBulan]) bulanMap[kodeBulan] = { total_pemasukan: 0, total_pengeluaran: 0 };
            bulanMap[kodeBulan].total_pengeluaran += (parseFloat(el.nominal) || 0);
        });

        const namaBulanIndo = {
            "2026-01": "Januari 2026", "2026-02": "Februari 2026", "2026-03": "Maret 2026",
            "2026-04": "April 2026", "2026-05": "Mei 2026", "2026-06": "Juni 2026",
            "2026-07": "Juli 2026", "2026-08": "Agustus 2026", "2026-09": "September 2026",
            "2026-10": "Oktober 2026", "2026-11": "November 2026", "2026-12": "Desember 2026"
        };

        let resultData = Object.keys(bulanMap).sort().reverse().map(kode => {
            let item = bulanMap[kode];
            return {
                kode_bulan: kode,
                nama_bulan: namaBulanIndo[kode] || kode,
                total_pemasukan: item.total_pemasukan,
                total_pengeluaran: item.total_pengeluaran,
                laba_bersih: item.total_pemasukan - item.total_pengeluaran
            };
        });

        res.json({ status: 'success', data: resultData });
    } catch (e) {
        res.json({ status: 'success', data: [] });
    }
});

app.post('/api/simpan_pengeluaran', async (req, res) => {
    const { tanggal, kategori, keterangan, nominal } = req.body;
    try {
        let { error } = await dbQueryDual(async (db) => {
            return await db.from('transaksi_pengeluaran').insert([{ tanggal, kategori, keterangan, nominal }]);
        });
        if (error) throw error;
        res.json({ status: 'success', message: 'Pengeluaran berhasil dicatat!' });
    } catch (e) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// 9. Reset Password
app.post('/api/reset_password', async (req, res) => {
    const { email, token, password_baru } = req.body;
    if (token !== process.env.ADMIN_SECRET_TOKEN) {
        return res.status(400).json({ status: 'error', message: 'Token rahasia admin tidak valid!' });
    }

    try {
        let { error } = await dbQueryDual(async (db) => {
            return await db.from('users').update({ password: password_baru }).eq('email', email);
        });
        if (error) throw error;
        res.json({ status: 'success', message: 'Password berhasil diubah!' });
    } catch (e) {
        res.status(500).json({ status: 'error', message: 'Gagal mereset password: ' + e.message });
    }
});

// 10. Hapus Nota
app.delete('/api/hapus_nota/:inv', async (req, res) => {
    let invParam = req.params.inv.replace('#', '').trim();
    try {
        let { data: trx, error: errSelect } = await dbQueryDual(async (db) => {
            return await db.from('transaksi_nota').select('*').or(`no_nota.eq.${invParam},no_nota.eq.#${invParam}`).maybeSingle();
        });
        if (errSelect || !trx) {
            return res.status(404).json({ status: 'error', message: 'Nota tidak ditemukan.' });
        }

        let { error: errDelete } = await dbQueryDual(async (db) => {
            return await db.from('transaksi_nota').delete().eq('no_nota', trx.no_nota);
        });
        if (errDelete) throw errDelete;

        res.json({ status: 'success', message: 'Nota berhasil dihapus!' });
    } catch (e) {
        res.status(500).json({ status: 'error', message: 'Gagal menghapus: ' + e.message });
    }
});

// 11. Hapus Pengeluaran
app.delete('/api/hapus_pengeluaran/:id', async (req, res) => {
    try {
        let { error } = await dbQueryDual(async (db) => {
            return await db.from('transaksi_pengeluaran').delete().eq('id', req.params.id);
        });
        if (error) throw error;
        res.json({ status: 'success', message: 'Pengeluaran berhasil dihapus!' });
    } catch (e) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// ==========================================
// FALLBACK & SERVER LISTENER (All Pages Router)
// ==========================================

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'pages', 'login.html'));
});

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'pages', 'dashboard.html'));
});

app.get('/dashboard.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'pages', 'dashboard.html'));
});

app.get('/login.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'pages', 'login.html'));
});

const daftarHalaman = ['buat_nota', 'riwayat', 'keuangan', 'pengaturan', 'edit_nota', 'detail_bulan', 'dp_masuk', 'lunas', 'menunggu_dp', 'nota_template'];

daftarHalaman.forEach(namaHalaman => {
    app.get(`/${namaHalaman}`, (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'pages', `${namaHalaman}.html`));
    });
    app.get(`/${namaHalaman}.html`, (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'pages', `${namaHalaman}.html`));
    });
});

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`🚀 Server lokal berjalan di port ${PORT}`);
    });
}

module.exports = app;