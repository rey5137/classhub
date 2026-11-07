<script lang="ts">
  import Card from '$lib/components/Card.svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';

  // R-AUTH-32: the public privacy notice, in Vietnamese, the class's language. It is the short
  // form of docs/PRIVACY.md; a change to what the site stores updates both.
</script>

<PageHeader title="Quyền riêng tư" lede="Trang lớp lưu gì về bạn, ai xem được, và lưu bao lâu." />

<div class="privacy">
  <Card class="sheet">
    <h2>Ai vận hành trang</h2>
    <p>
      Đây là trang riêng của một lớp, do các quản trị viên của lớp vận hành trên tài khoản
      Cloudflare của họ. Không có dịch vụ trung tâm nào khác xem được dữ liệu của lớp. Trang dùng
      hai dịch vụ bên ngoài: <strong>Cloudflare</strong> (máy chủ, cơ sở dữ liệu, ảnh và kiểm tra
      đăng nhập) và
      <strong>Google</strong> hoặc mã đăng nhập gửi qua email (để xác nhận bạn là ai). Khi bạn đăng nhập,
      trang chỉ nhận địa chỉ email đã xác minh của bạn. Trang không dùng quảng cáo, công cụ thống kê hay
      mã theo dõi của bên thứ ba.
    </p>

    <h2>Ai vào được</h2>
    <p>
      Chỉ những người được quản trị viên mời. Người khác, kể cả tài khoản Google không có trong danh
      sách, đều thấy cùng một trang “không có quyền truy cập” và không nhận được dữ liệu nào.
    </p>

    <h2>Trang lưu gì về bạn</h2>
    <ul>
      <li>
        <strong>Email đăng nhập:</strong> chỉ bạn và quản trị viên thấy, không bao giờ hiện cho thành
        viên khác.
      </li>
      <li><strong>Tên hiển thị:</strong> mọi thành viên thấy.</li>
      <li>
        <strong>Biệt danh, giới thiệu ngắn, ảnh đại diện:</strong> mặc định mọi thành viên thấy; bạn đổi
        được.
      </li>
      <li>
        <strong>Email liên hệ, số điện thoại, Zalo/Messenger, thành phố:</strong> mặc định chỉ bạn thấy;
        bạn chọn ai được xem từng mục (chỉ mình tôi, quản trị viên, hoặc mọi thành viên).
      </li>
      <li><strong>Ảnh, bài viết, bình luận, tin nhắn:</strong> mọi thành viên thấy.</li>
    </ul>
    <p>
      Ảnh được trình duyệt của bạn nén lại trước khi tải lên, nên thông tin EXIF (kể cả vị trí GPS)
      bị xoá. Nhật ký máy chủ không ghi email, thông tin liên hệ hay nội dung tin nhắn.
    </p>

    <h2>Email và thông báo</h2>
    <p>
      Trang chỉ gửi một loại email: thư mời, khi quản trị viên bấm gửi cho người được mời, từ địa
      chỉ Gmail của quản trị viên. Thông báo đẩy chỉ bật khi bạn tự bật trên từng thiết bị, và nội
      dung được mã hoá đến tận thiết bị của bạn.
    </p>

    <h2>Lưu bao lâu</h2>
    <ul>
      <li>Bài viết và bình luận: đến khi người viết hoặc quản trị viên xoá.</li>
      <li>Tin nhắn: mặc định 365 ngày; tin cũ hơn được lưu trữ mã hoá bởi quản trị viên.</li>
      <li>Ảnh đã xoá: biến mất ngay, tệp được xoá hẳn sau thời gian chờ (mặc định 7 ngày).</li>
      <li>
        Bản sao lưu: được mã hoá và giữ tối đa khoảng một năm (12 bản hằng tuần và 12 bản hằng
        tháng).
      </li>
    </ul>

    <h2>Quyền của bạn</h2>
    <p>
      Trong trang hồ sơ, bạn có thể đổi ai được xem từng mục, tải xuống dữ liệu của mình, xoá hồ sơ,
      hoặc yêu cầu xoá tài khoản. Có câu hỏi, hãy hỏi quản trị viên của lớp.
    </p>
  </Card>
</div>

<style>
  .privacy :global(.sheet) {
    max-width: 46rem;
    padding: calc(var(--space-unit) * 6);
  }

  h2 {
    margin: calc(var(--space-unit) * 6) 0 calc(var(--space-unit) * 2);
    font-size: 1.125rem;
  }

  h2:first-child {
    margin-top: 0;
  }

  p,
  li {
    line-height: 1.6;
  }

  ul {
    padding-left: 1.25rem;
  }
</style>
